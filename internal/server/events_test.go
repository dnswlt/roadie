package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func TestHubBroadcastReachesSubscribers(t *testing.T) {
	h := newHub()
	a := h.subscribe(1)
	b := h.subscribe(1)
	other := h.subscribe(2) // different roadmap: must not receive

	h.broadcast(1, "origin-x")

	for _, ch := range []chan changeEvent{a, b} {
		select {
		case ev := <-ch:
			if ev.RoadmapID != 1 || ev.Origin != "origin-x" {
				t.Fatalf("unexpected event: %+v", ev)
			}
			if ev.Rev != 1 {
				t.Fatalf("rev = %d, want 1", ev.Rev)
			}
		default:
			t.Fatal("subscriber did not receive the event")
		}
	}

	select {
	case ev := <-other:
		t.Fatalf("subscriber of a different roadmap received %+v", ev)
	default:
	}
}

func TestHubRevIsMonotonicPerRoadmap(t *testing.T) {
	h := newHub()
	ch := h.subscribe(1)
	h.broadcast(1, "")
	h.broadcast(1, "")
	if ev := <-ch; ev.Rev != 1 {
		t.Fatalf("first rev = %d, want 1", ev.Rev)
	}
	if ev := <-ch; ev.Rev != 2 {
		t.Fatalf("second rev = %d, want 2", ev.Rev)
	}
}

func TestHubUnsubscribeStopsDelivery(t *testing.T) {
	h := newHub()
	ch := h.subscribe(1)
	h.unsubscribe(1, ch)
	h.broadcast(1, "")
	select {
	case <-ch:
		t.Fatal("received an event after unsubscribing")
	default:
	}
}

// TestServerShutdownReleasesSSE guards against the graceful-shutdown stall:
// an SSE connection is never idle, so without the shutdown signal srv.Shutdown
// would block until its timeout. Shutdown() must release the handler at once.
func TestServerShutdownReleasesSSE(t *testing.T) {
	// The events route needs the store now: like every route that names a
	// roadmap it is wrapped in guard, which authorizes the subscriber against
	// that roadmap before the stream opens. It still needs no static FS.
	app := New(testStore, nil)
	ts := httptest.NewServer(app)
	defer ts.Close()

	id := strconv.FormatInt(seedRoadmap(t, "test-"+t.Name()), 10)

	// http.Get returns once headers arrive, i.e. after the handler's first
	// flush — so by here it is running and subscribed.
	resp, err := http.Get(ts.URL + "/api/roadmaps/" + id + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	app.Shutdown()

	done := make(chan struct{})
	go func() {
		io.Copy(io.Discard, resp.Body) // returns when the handler releases the conn
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("SSE handler did not release after Shutdown")
	}
}

func TestHubBroadcastDropsWhenBufferFull(t *testing.T) {
	h := newHub()
	ch := h.subscribe(1)
	// Overfill past the channel buffer; broadcast must not block.
	for i := 0; i < cap(ch)+5; i++ {
		h.broadcast(1, "")
	}
	// The buffer holds cap(ch) events; the rest were dropped, not deadlocked.
	if len(ch) != cap(ch) {
		t.Fatalf("buffered %d events, want %d", len(ch), cap(ch))
	}
}
