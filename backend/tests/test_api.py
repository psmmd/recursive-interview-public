import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

# Import the app
import backend.main as main

client = TestClient(main.app)


@pytest.fixture(autouse=True)
def reset_state():
    """Reset the in-memory datastore before every test so no state leaks between tests."""
    main.WORKOUTS = []
    main.WORKOUT_ID_COUNTER = 1
    # Provide a small deterministic exercise catalog
    main.EXERCISES = [
        main.Exercise(id=1, name="Squat", muscle_group="Legs", equipment="Barbell", type="strength"),
        main.Exercise(id=2, name="Run", muscle_group="Full Body", equipment=None, type="cardio"),
        main.Exercise(id=3, name="Plank", muscle_group="Core", equipment=None, type="mobility"),
    ]


# -------------------------
# Health & exercises
# -------------------------
def test_health():
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_list_exercises_filters():
    # No filter
    r = client.get("/api/exercises")
    assert r.status_code == 200
    assert [e["name"] for e in r.json()] == ["Squat", "Run", "Plank"]

    # Query by name
    r = client.get("/api/exercises", params={"q": "squ"})
    assert r.status_code == 200
    assert [e["name"] for e in r.json()] == ["Squat"]

    # Filter by type
    r = client.get("/api/exercises", params={"type": "cardio"})
    assert r.status_code == 200
    assert [e["name"] for e in r.json()] == ["Run"]

    # Filter by muscle_group (case-insensitive)
    r = client.get("/api/exercises", params={"muscle_group": "legs"})
    assert r.status_code == 200
    assert [e["name"] for e in r.json()] == ["Squat"]

    # No match returns an empty list, not an error
    r = client.get("/api/exercises", params={"q": "does-not-exist"})
    assert r.status_code == 200
    assert r.json() == []


# -------------------------
# Workout validation
# -------------------------
@pytest.mark.parametrize(
    "items, expected_detail",
    [
        ([], "Workout must contain at least one item"),
        ([{"exercise_id": 999, "sets": 3, "reps": 10}], "Item 1: Exercise not found (id=999)"),
        ([{"exercise_id": 1}], "Item 1: Must provide either sets & reps"),
        # Partial prescriptions: sets without reps, reps without sets
        ([{"exercise_id": 1, "sets": 3}], "Item 1: Must provide either sets & reps"),
        ([{"exercise_id": 1, "reps": 10}], "Item 1: Must provide either sets & reps"),
        # Error points at the offending item, not the first one
        (
            [{"exercise_id": 1, "sets": 3, "reps": 10}, {"exercise_id": 2}],
            "Item 2: Must provide either sets & reps",
        ),
    ],
)
def test_create_workout_validation_errors(items, expected_detail):
    r = client.post("/api/workouts", json={"name": "Test", "items": items})
    assert r.status_code == 400
    assert expected_detail in r.json()["detail"]
    # A rejected workout must not be stored
    assert main.WORKOUTS == []
    assert client.get("/api/workouts").json() == []


@pytest.mark.parametrize("field", ["sets", "reps", "duration_seconds"])
def test_create_workout_rejects_non_positive_values(field):
    item = {"exercise_id": 1, "sets": 3, "reps": 10} if field != "duration_seconds" else {"exercise_id": 2}
    item[field] = 0
    r = client.post("/api/workouts", json={"name": "Test", "items": [item]})
    assert r.status_code == 422
    assert main.WORKOUTS == []


# -------------------------
# Workout CRUD
# -------------------------
def test_create_get_list_delete_workout():
    payload = {
        "name": "Leg Day",
        "items": [
            {"exercise_id": 1, "sets": 3, "reps": 10, "notes": "Heavy"},
            {"exercise_id": 2, "duration_seconds": 300},
        ],
    }

    # Create echoes exactly what was sent, plus an id
    r = client.post("/api/workouts", json=payload)
    assert r.status_code == 201
    created = r.json()
    assert created["id"] == 1
    assert created["name"] == "Leg Day"
    assert created["items"] == [
        {"exercise_id": 1, "sets": 3, "reps": 10, "duration_seconds": None, "notes": "Heavy"},
        {"exercise_id": 2, "sets": None, "reps": None, "duration_seconds": 300, "notes": None},
    ]

    # Get by id returns the same workout
    r = client.get("/api/workouts/1")
    assert r.status_code == 200
    assert r.json() == created

    # List shows only the new workout
    r = client.get("/api/workouts")
    assert r.status_code == 200
    assert r.json() == [created]

    # Delete it
    r = client.delete("/api/workouts/1")
    assert r.status_code == 204
    assert r.content == b""

    # It is gone from list and get
    assert client.get("/api/workouts").json() == []
    assert client.get("/api/workouts/1").status_code == 404


def test_workout_ids_increment():
    body = {"name": "A", "items": [{"exercise_id": 2, "duration_seconds": 60}]}
    first = client.post("/api/workouts", json=body).json()
    second = client.post("/api/workouts", json={**body, "name": "B"}).json()
    assert (first["id"], second["id"]) == (1, 2)


def test_get_missing_workout_returns_404():
    r = client.get("/api/workouts/42")
    assert r.status_code == 404
    assert r.json()["detail"] == "Workout not found"


def test_delete_missing_workout_returns_404_and_keeps_others():
    client.post("/api/workouts", json={"name": "Keep", "items": [{"exercise_id": 2, "duration_seconds": 60}]})

    r = client.delete("/api/workouts/42")
    assert r.status_code == 404
    assert r.json()["detail"] == "Workout not found"
    assert [w["name"] for w in client.get("/api/workouts").json()] == ["Keep"]


# -------------------------
# AI endpoints (OpenAI client faked, no network)
# -------------------------
class FakeOpenAI:
    """Minimal stand-in for the OpenAI client: returns `content` and records the call."""

    def __init__(self, content=None, error=None):
        self.calls = []
        self._content = content
        self._error = error
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        if self._error:
            raise self._error
        message = SimpleNamespace(content=self._content)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])


@pytest.fixture
def fake_ai(monkeypatch):
    """Install a fake AI client; returns a factory so each test chooses the reply."""

    def install(content=None, error=None):
        fake = FakeOpenAI(content=content, error=error)
        monkeypatch.setattr(main, "client", fake)
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        return fake

    return install


@pytest.mark.parametrize(
    "path, body",
    [
        ("/api/ai/chat", {"prompt": "hi"}),
        ("/api/ai/plan", {"prompt": "leg day"}),
        ("/api/ai/program", {"prompt": "3 day split"}),
    ],
)
def test_ai_routes_return_500_when_not_configured(monkeypatch, path, body):
    monkeypatch.setattr(main, "client", None)
    r = client.post(path, json=body)
    assert r.status_code == 500
    assert "AI not configured" in r.json()["detail"]


def test_ai_chat_with_prompt(fake_ai):
    fake = fake_ai(content="Hello!")
    r = client.post("/api/ai/chat", json={"prompt": "Say hi", "model": "test-model"})
    assert r.status_code == 200
    assert r.json() == {"reply": "Hello!", "model": "test-model"}
    assert fake.calls[0]["messages"] == [{"role": "user", "content": "Say hi"}]
    assert fake.calls[0]["model"] == "test-model"


def test_ai_chat_with_messages(fake_ai):
    fake = fake_ai(content="ok")
    messages = [
        {"role": "system", "content": "You are a coach."},
        {"role": "user", "content": "Plan a push day."},
    ]
    r = client.post("/api/ai/chat", json={"messages": messages})
    assert r.status_code == 200
    assert r.json()["reply"] == "ok"
    assert fake.calls[0]["messages"] == messages


def test_ai_chat_requires_prompt_or_messages(fake_ai):
    fake = fake_ai(content="unused")
    r = client.post("/api/ai/chat", json={})
    assert r.status_code == 400
    assert r.json()["detail"] == "Provide either 'messages' or 'prompt'"
    assert fake.calls == []


def test_ai_chat_upstream_failure_returns_500(fake_ai):
    fake_ai(error=RuntimeError("upstream down"))
    r = client.post("/api/ai/chat", json={"prompt": "hi"})
    assert r.status_code == 500
    assert "upstream down" in r.json()["detail"]


VALID_PLAN_ITEM = {
    "exercise": {
        "exercise_id": 1,
        "name": "Squat",
        "equipment_type": "Barbell",
        "target_muscle_groups": {"primary": ["Legs"], "secondary": []},
        "utility": "Compound",
    },
    "prescription": {"exercise_id": 1, "sets": 3, "reps": 10, "duration_seconds": None, "notes": None},
}


def test_ai_plan_returns_parsed_plan(fake_ai):
    fake = fake_ai(content=json.dumps({"name": "Leg Day", "items": [VALID_PLAN_ITEM]}))
    r = client.post("/api/ai/plan", json={"prompt": "legs", "name": "Leg Day"})
    assert r.status_code == 200
    plan = r.json()
    assert plan["name"] == "Leg Day"
    assert len(plan["items"]) == 1
    assert plan["items"][0]["exercise"]["name"] == "Squat"
    assert plan["items"][0]["prescription"]["sets"] == 3
    # The requested name is forwarded to the model
    assert "Leg Day" in fake.calls[0]["messages"][1]["content"]


def test_ai_program_returns_parsed_program(fake_ai):
    program = {"name": "Split", "days": [{"name": "Day 1", "items": [VALID_PLAN_ITEM]}], "suggestions": None}
    fake_ai(content=json.dumps(program))
    r = client.post("/api/ai/program", json={"prompt": "split"})
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "Split"
    assert [d["name"] for d in body["days"]] == ["Day 1"]
    assert body["days"][0]["items"][0]["exercise"]["exercise_id"] == 1


@pytest.mark.parametrize("path", ["/api/ai/plan", "/api/ai/program"])
@pytest.mark.parametrize(
    "content",
    [
        "Sure! Here is your plan: ...",  # not JSON at all
        json.dumps({"items": []}),  # JSON, but missing required fields
    ],
)
def test_ai_plan_and_program_reject_malformed_model_output(fake_ai, path, content):
    fake_ai(content=content)
    r = client.post(path, json={"prompt": "anything"})
    assert r.status_code == 500
    assert "generation failed" in r.json()["detail"]
