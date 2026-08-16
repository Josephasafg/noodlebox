"""
Tests for reading settings out of the project's `.env`.

The point of this file is that pointing the reader at a vision model is an edit
someone makes once, not something exported before every run — so what matters is
that the values arrive, that a shell still overrides them, and that a malformed
line cannot take the service down with it.

    python3 -m pytest scripts/tabvideo/tests/test_env.py
"""

from __future__ import annotations

from scripts.tabvideo import env as env_mod


def test_a_plain_setting_is_read():
    assert env_mod.parse("TABVIDEO_VLM_MODEL=Qwen/Qwen2.5-VL-32B-Instruct") == {
        "TABVIDEO_VLM_MODEL": "Qwen/Qwen2.5-VL-32B-Instruct"
    }


def test_the_shapes_a_person_actually_types_are_all_accepted():
    # Quotes, an `export` pasted from a shell, spaces around the equals, and a
    # value with an equals in it: each one is somebody copying a line from the
    # README, and none of them should silently do nothing.
    found = env_mod.parse(
        "\n".join(
            [
                "# a comment",
                "",
                "  export TABVIDEO_VLM_URL = http://127.0.0.1:8000/v1  ",
                "TABVIDEO_VLM_KEY='sk-secret'",
                'TABVIDEO_VLM_MODEL="a model"',
                "TABVIDEO_OPAQUE=a=b",
            ]
        )
    )
    assert found == {
        "TABVIDEO_VLM_URL": "http://127.0.0.1:8000/v1",
        "TABVIDEO_VLM_KEY": "sk-secret",
        "TABVIDEO_VLM_MODEL": "a model",
        "TABVIDEO_OPAQUE": "a=b",
    }


def test_a_line_that_is_not_a_setting_is_skipped_rather_than_fatal():
    # A half-edited file must not stop the reader from starting; the settings it
    # does contain still apply, and naming falls back to a person regardless.
    assert env_mod.parse("nonsense\n=novalue\nTABVIDEO_VLM_MODEL=m\n") == {
        "TABVIDEO_VLM_MODEL": "m"
    }


def test_a_local_file_wins_over_the_shared_one(tmp_path):
    # `.env.local` is where a token belongs, so it has to be able to override.
    (tmp_path / ".env").write_text("TABVIDEO_VLM_URL=http://shared/v1\nTABVIDEO_VLM_KEY=none\n")
    (tmp_path / ".env.local").write_text("TABVIDEO_VLM_KEY=sk-real\n")
    found = env_mod.read(tmp_path)
    assert found["TABVIDEO_VLM_URL"] == "http://shared/v1"
    assert found["TABVIDEO_VLM_KEY"] == "sk-real"


def test_a_value_from_the_shell_is_left_alone(tmp_path):
    # Otherwise a one-off run with a different endpoint would be silently ignored.
    (tmp_path / ".env").write_text("TABVIDEO_VLM_URL=http://from-file/v1\nTABVIDEO_VLM_MODEL=m\n")
    environ = {"TABVIDEO_VLM_URL": "http://from-shell/v1"}
    applied = env_mod.apply(tmp_path, environ)
    assert environ["TABVIDEO_VLM_URL"] == "http://from-shell/v1"
    assert environ["TABVIDEO_VLM_MODEL"] == "m"
    assert applied == {"TABVIDEO_VLM_MODEL": "m"}


def test_no_env_file_at_all_is_the_ordinary_case(tmp_path):
    environ: dict[str, str] = {}
    assert env_mod.apply(tmp_path, environ) == {}
    assert environ == {}
