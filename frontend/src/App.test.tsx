import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import type { Exercise, Workout } from "./types";
import * as api from "./api";

vi.mock("./api", () => ({
  getHealth: vi.fn(),
  getInitialData: vi.fn(),
  getExercises: vi.fn(),
  getWorkouts: vi.fn(),
  createWorkout: vi.fn(),
  deleteWorkout: vi.fn(),
}));

const sampleExercises: Exercise[] = [
  { id: 1, name: "Barbell Back Squat", muscle_group: "Legs", equipment: "Barbell", type: "strength" },
  { id: 2, name: "Running", muscle_group: "Full Body", equipment: null as any, type: "cardio" },
];

// Fresh QueryClient per render so cached initial data never leaks between tests
function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  );
}

// The "Saved Workouts" section, so assertions don't match text elsewhere on the page
function savedSection() {
  return within(screen.getByRole("heading", { name: "Saved Workouts" }).parentElement as HTMLElement);
}

describe("App", () => {
  beforeEach(() => {
    (api.getHealth as any).mockResolvedValue({ status: "ok" });
    (api.getInitialData as any).mockResolvedValue({ exercises: sampleExercises, workouts: [] as Workout[] });
    (api.getExercises as any).mockResolvedValue(sampleExercises);
    (api.getWorkouts as any).mockResolvedValue([] as Workout[]);
    (api.createWorkout as any).mockResolvedValue({ id: 1, name: "", items: [] });
    (api.deleteWorkout as any).mockResolvedValue(undefined);
  });

  it("renders the exercises returned by the initial data load", async () => {
    renderApp();

    expect(await screen.findByText("Barbell Back Squat")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Legs • strength • Barbell")).toBeInTheDocument();
    expect(screen.getByText("Full Body • cardio")).toBeInTheDocument();
    expect(api.getInitialData).toHaveBeenCalledTimes(1);
  });

  it("shows the error when the initial data load fails", async () => {
    (api.getInitialData as any).mockRejectedValue(new Error("Backend unavailable"));

    renderApp();

    expect(await screen.findByText("Backend unavailable")).toBeInTheDocument();
    expect(screen.getByText("No exercises found.")).toBeInTheDocument();
  });

  it("does not call the API when the workout name is missing", async () => {
    renderApp();

    await userEvent.click((await screen.findAllByRole("button", { name: "Add" }))[0]);
    await userEvent.click(screen.getByRole("button", { name: "Save Workout" }));

    expect(await screen.findByText("Please provide a workout name.")).toBeInTheDocument();
    expect(api.createWorkout).not.toHaveBeenCalled();
  });

  it("saves the built workout with the right payload, refreshes the list and resets the form", async () => {
    const saved: Workout = {
      id: 1,
      name: "Leg Day",
      items: [
        { exercise_id: 1, sets: 3, reps: 10 },
        { exercise_id: 2, duration_seconds: 300 },
      ],
    };
    (api.createWorkout as any).mockResolvedValue(saved);
    (api.getWorkouts as any).mockResolvedValueOnce([saved]);

    renderApp();

    // Add a strength and a cardio exercise: each gets its default prescription
    const addButtons = await screen.findAllByRole("button", { name: "Add" });
    await userEvent.click(addButtons[0]);
    await userEvent.click(addButtons[1]);

    await userEvent.type(screen.getByPlaceholderText(/Workout name/i), "  Leg Day  ");
    await userEvent.click(screen.getByRole("button", { name: "Save Workout" }));

    // The list now shows what the server returned after the save
    expect(await savedSection().findByText("Leg Day")).toBeInTheDocument();
    expect(savedSection().getByText("2 items")).toBeInTheDocument();

    // The request carried exactly what the user built (name trimmed)
    expect(api.createWorkout).toHaveBeenCalledTimes(1);
    expect(api.createWorkout).toHaveBeenCalledWith({
      name: "Leg Day",
      items: [
        { exercise_id: 1, sets: 3, reps: 10 },
        { exercise_id: 2, duration_seconds: 300 },
      ],
    });

    // The builder is reset
    expect(screen.getByPlaceholderText(/Workout name/i)).toHaveValue("");
    expect(screen.getByText("No items yet. Add exercises from the list.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Workout" })).toBeDisabled();
  });

  it("keeps the form and shows the server error when saving fails", async () => {
    (api.createWorkout as any).mockRejectedValue(new Error("Item 1: Exercise not found (id=1)"));

    renderApp();

    await userEvent.click((await screen.findAllByRole("button", { name: "Add" }))[0]);
    await userEvent.type(screen.getByPlaceholderText(/Workout name/i), "Leg Day");
    await userEvent.click(screen.getByRole("button", { name: "Save Workout" }));

    expect(await screen.findByText("Item 1: Exercise not found (id=1)")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Workout name/i)).toHaveValue("Leg Day");
    expect(api.getWorkouts).not.toHaveBeenCalled();
    expect(savedSection().getByText("No saved workouts.")).toBeInTheDocument();
  });

  it("deletes a saved workout and refreshes the list", async () => {
    const workout: Workout = { id: 5, name: "Push Day", items: [{ exercise_id: 1, sets: 5, reps: 5 }] };
    (api.getInitialData as any).mockResolvedValue({ exercises: sampleExercises, workouts: [workout] });
    (api.getWorkouts as any).mockResolvedValueOnce([]);

    renderApp();

    expect(await savedSection().findByText("Push Day")).toBeInTheDocument();
    await userEvent.click(savedSection().getByRole("button", { name: "Delete" }));

    expect(await savedSection().findByText("No saved workouts.")).toBeInTheDocument();
    expect(api.deleteWorkout).toHaveBeenCalledWith(5);
    expect(savedSection().queryByText("Push Day")).not.toBeInTheDocument();
  });

  it("searches with the selected filters and shows the results", async () => {
    (api.getExercises as any).mockResolvedValueOnce([sampleExercises[1]]);

    renderApp();

    await screen.findByText("Barbell Back Squat");
    await userEvent.type(screen.getByPlaceholderText("Search by name..."), "run");
    await userEvent.selectOptions(screen.getByDisplayValue("All muscle groups"), "Full Body");
    await userEvent.selectOptions(screen.getByDisplayValue("All types"), "cardio");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(api.getExercises).toHaveBeenCalledWith({ q: "run", muscle_group: "Full Body", type: "cardio" });
    expect(await screen.findByText("Running")).toBeInTheDocument();
    expect(screen.queryByText("Barbell Back Squat")).not.toBeInTheDocument();
  });
});
