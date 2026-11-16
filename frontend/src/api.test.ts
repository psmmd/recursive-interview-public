import { describe, it, expect, vi, afterEach } from "vitest";
import { createWorkout, deleteWorkout, getExercises, getWorkouts } from "./api";

// Build a minimal fetch Response. api.ts reads errors via text() and successes via json().
function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as any;
}
function errorResponse(status: number, text: string) {
  return {
    ok: false,
    status,
    text: async () => text,
    json: async () => {
      throw new Error("json() must not be used for error bodies");
    },
  } as any;
}

describe("api", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getExercises builds query string and returns JSON", async () => {
    const mockData = [{ id: 1, name: "Squat", muscle_group: "Legs", equipment: "Barbell", type: "strength" }];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse(mockData));

    const res = await getExercises({ q: "squat", type: "strength" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("/api/exercises?q=squat&type=strength");
    expect(res).toEqual(mockData);
  });

  it("getExercises omits empty and whitespace-only params", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse([]));

    await getExercises({ q: "  ", muscle_group: "", type: "strength" });

    expect(fetchSpy.mock.calls[0][0]).toBe("/api/exercises?type=strength");
  });

  it("getExercises without params has no query string", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse([]));

    await getExercises();

    expect(fetchSpy.mock.calls[0][0]).toBe("/api/exercises");
  });

  it("uses the JSON 'detail' field as the error message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse(400, JSON.stringify({ detail: "Item 1: Exercise not found (id=999)" }))
    );

    const err = await getExercises({ type: "strength" }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    // Exact match: must be the detail, not the raw JSON body
    expect(err.message).toBe("Item 1: Exercise not found (id=999)");
  });

  it("handles non-JSON error body by using text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(errorResponse(502, "Upstream error"));

    const err = await getExercises({ type: "strength" }).catch((e) => e);

    expect(err.message).toBe("Upstream error");
  });

  it("handles JSON error without 'detail' by keeping raw JSON text", async () => {
    const body = JSON.stringify({ error: "X", message: "no detail field" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(errorResponse(500, body));

    const err = await getExercises({ type: "strength" }).catch((e) => e);

    expect(err.message).toBe(body);
  });

  it("falls back to a status message when the error body is empty", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(errorResponse(503, ""));

    const err = await getExercises().catch((e) => e);

    expect(err.message).toBe("Request failed with status 503");
  });

  it("createWorkout POSTs the payload as JSON and returns the created workout", async () => {
    const payload = { name: "Leg Day", items: [{ exercise_id: 1, sets: 3, reps: 10 }] };
    const created = { id: 1, ...payload };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse(created));

    const res = await createWorkout(payload);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/workouts");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual(payload);
    expect(res).toEqual(created);
  });

  it("deleteWorkout sends DELETE to the workout URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, status: 204 } as any);

    await expect(deleteWorkout(7)).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledWith("/api/workouts/7", { method: "DELETE" });
  });

  it("deleteWorkout throws the detail on failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(errorResponse(404, JSON.stringify({ detail: "Workout not found" })));

    const err = await deleteWorkout(42).catch((e) => e);

    expect(err.message).toBe("Workout not found");
  });

  it("dedupes identical in-flight requests, then allows a new request once settled", async () => {
    let resolveFetch!: (v: any) => void;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => new Promise((r) => (resolveFetch = r)))
      .mockResolvedValueOnce(okResponse([{ id: 2 }]));

    const a = getWorkouts();
    const b = getWorkouts();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    resolveFetch(okResponse([{ id: 1 }]));
    expect(await a).toEqual([{ id: 1 }]);
    expect(await b).toEqual([{ id: 1 }]);

    // After settling, the next call hits the network again
    expect(await getWorkouts()).toEqual([{ id: 2 }]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not dedupe requests with different methods on the same URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => okResponse({}));

    await Promise.all([getWorkouts(), createWorkout({ name: "A", items: [] })]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("getInitialData", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // getInitialData caches its promise at module level; reload the module for each test
    vi.resetModules();
  });

  function routeFetch(routes: Record<string, () => any>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const handler = routes[String(input)];
      if (!handler) throw new Error(`Unexpected fetch: ${input}`);
      return handler();
    });
  }

  it("checks health, then loads exercises and workouts, and caches the result", async () => {
    const { getInitialData } = await import("./api");
    const fetchSpy = routeFetch({
      "/api/health": () => okResponse({ status: "ok" }),
      "/api/exercises": () => okResponse([{ id: 1 }]),
      "/api/workouts": () => okResponse([{ id: 9 }]),
    });

    const first = await getInitialData();
    const second = await getInitialData();

    expect(first).toEqual({ exercises: [{ id: 1 }], workouts: [{ id: 9 }] });
    expect(second).toBe(first);
    expect(fetchSpy.mock.calls.map((c) => c[0])).toEqual(["/api/health", "/api/exercises", "/api/workouts"]);
  });

  it("does not load data when the health check fails, and retries on the next call", async () => {
    const { getInitialData } = await import("./api");
    let healthy = false;
    const fetchSpy = routeFetch({
      "/api/health": () => (healthy ? okResponse({ status: "ok" }) : errorResponse(502, "Bad Gateway")),
      "/api/exercises": () => okResponse([]),
      "/api/workouts": () => okResponse([]),
    });

    await expect(getInitialData()).rejects.toThrow("Bad Gateway");
    expect(fetchSpy.mock.calls.map((c) => c[0])).toEqual(["/api/health"]);

    // Failure is not cached: a later call tries again
    healthy = true;
    await expect(getInitialData()).resolves.toEqual({ exercises: [], workouts: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});
