#!/usr/bin/env python3

"""Recreate the canonical roadmap used for documentation screenshots.

Needs a local server on :8080 and pip install -r requirements-docs.txt.
"""

import json
from pathlib import Path

import requests

BASE_URL = "http://localhost:8080"
FIXTURE = Path(__file__).resolve().parents[1] / "docs/fixtures/example-roadmap.roadie.json"
REQUEST_TIMEOUT = 15


def request(session, method, path, **kwargs):
    response = session.request(method, BASE_URL + path, timeout=REQUEST_TIMEOUT, **kwargs)
    response.raise_for_status()
    return response


def matching_ids(roadmaps, name):
    return [roadmap["id"] for roadmap in roadmaps if roadmap["name"] == name]


def recreate():
    fixture = json.loads(FIXTURE.read_text())
    name = fixture["roadmap"]["name"]

    with requests.Session() as session:
        live = request(session, "GET", "/api/roadmaps").json()
        trashed = request(session, "GET", "/api/roadmaps/trash").json()

        # Permanent deletion is intentional: old copies are generated data, and
        # retaining them would make repeated screenshot setup accumulate trash.
        for roadmap_id in matching_ids(trashed, name):
            request(session, "DELETE", f"/api/roadmaps/{roadmap_id}/purge")
        for roadmap_id in matching_ids(live, name):
            request(session, "DELETE", f"/api/roadmaps/{roadmap_id}")
            request(session, "DELETE", f"/api/roadmaps/{roadmap_id}/purge")

        created = request(session, "POST", "/api/roadmaps/import", json=fixture).json()

    print(f"Recreated {name!r}: {BASE_URL}/?roadmap={created['id']}")


if __name__ == "__main__":
    recreate()
