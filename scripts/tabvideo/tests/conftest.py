"""
Keep the suite hermetic.

Settings now come from a `.env` beside the app, which is the point — nothing has
to be exported before the reader runs. The cost is that importing the service
also configures it, so a developer with a vision model set up would have every
job in this suite call that model for real: slow, non-deterministic, and quietly
dependent on a pod being reachable.

So the endpoint is unset for every test. Tests about naming supply their own
namer explicitly (`test_server.py` patches `Namer.from_env`) or pass an
environment in by hand (`test_namer.py`), which is the honest way to say a test
is about that path.
"""

from __future__ import annotations

import pytest

from scripts.tabvideo import namer as namer_mod

# Everything that would point the namer at a real endpoint.
SETTINGS = (
    namer_mod.URL_VAR,
    namer_mod.MODEL_VAR,
    namer_mod.KEY_VAR,
    namer_mod.EXEMPLARS_VAR,
    namer_mod.CONCURRENCY_VAR,
    namer_mod.TIMEOUT_VAR,
    namer_mod.BUDGET_VAR,
)


@pytest.fixture(autouse=True)
def no_vision_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in SETTINGS:
        monkeypatch.delenv(name, raising=False)
