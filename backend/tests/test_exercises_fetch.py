import json
import logging

import backend.main as main


def write_json(tmp_path, content: str) -> str:
    path = tmp_path / "exercises.json"
    path.write_text(content, encoding="utf-8")
    return path.as_uri()


def test_load_exercises_from_uri_with_valid_local_file(tmp_path):
    data = {
        "exercise_library": [
            {
                "exercise_id": 101,
                "name": "Test Squat",
                "equipment_type": "Barbell",
                "target_muscle_groups": {"primary": ["Legs", "Glutes"]},
                "utility": "Strength",
            },
            {
                "exercise_id": 102,
                "name": "Test Run",
                "equipment_type": None,
                "target_muscle_groups": {"primary": ["Full Body"]},
                "utility": "Cardio",
            },
            {
                "exercise_id": 103,
                "name": "Test Stretch",
                "equipment_type": None,
                "target_muscle_groups": {"primary": [], "secondary": ["Hamstrings"]},
                "utility": "Flexibility",
            },
        ]
    }
    items = main.load_exercises_from_uri(write_json(tmp_path, json.dumps(data)), timeout=2.0)

    assert [(e.id, e.name, e.muscle_group, e.equipment, e.type) for e in items] == [
        (101, "Test Squat", "Legs, Glutes", "Barbell", "strength"),
        (102, "Test Run", "Full Body", None, "cardio"),
        # Falls back to secondary muscles when primary is empty
        (103, "Test Stretch", "Hamstrings", None, "mobility"),
    ]


def test_load_exercises_skips_malformed_items_and_keeps_the_rest(tmp_path):
    data = {
        "exercise_library": [
            {"name": "No id"},  # missing exercise_id
            {"exercise_id": "not-a-number", "name": "Bad id"},
            {"exercise_id": 7, "name": "Good"},
        ]
    }
    items = main.load_exercises_from_uri(write_json(tmp_path, json.dumps(data)), timeout=2.0)

    assert [(e.id, e.name) for e in items] == [(7, "Good")]
    # Defaults applied when optional fields are missing
    assert items[0].muscle_group == "Unknown"
    assert items[0].type == "strength"


def test_load_exercises_from_uri_with_invalid_json_returns_empty(tmp_path, caplog):
    uri = write_json(tmp_path, "{ invalid json ")

    with caplog.at_level(logging.ERROR, logger="workout_backend"):
        items = main.load_exercises_from_uri(uri, timeout=1.0)

    assert items == []
    # The loader swallows every exception, so check it failed for the right reason
    errors = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert len(errors) == 1
    assert errors[0].exc_info is not None
    assert errors[0].exc_info[0] is json.JSONDecodeError


def test_load_exercises_from_missing_file_returns_empty_and_logs(tmp_path, caplog):
    uri = (tmp_path / "missing.json").as_uri()

    with caplog.at_level(logging.ERROR, logger="workout_backend"):
        items = main.load_exercises_from_uri(uri, timeout=1.0)

    assert items == []
    errors = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert len(errors) == 1
    assert "Failed to load exercises" in errors[0].getMessage()
