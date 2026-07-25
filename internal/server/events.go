package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// clientIDHeader carries a per-tab id sent by the frontend on every mutating
// request. It is echoed back in the change event's Origin field so a client can
// ignore the events caused by its own edits (otherwise every field save would
// bounce back and refresh the editor under the user's cursor).
const clientIDHeader = "X-Client-Id"

// sseHeartbeat keeps the SSE connection alive through idle-timeout proxies: a
// comment line costs nothing and resets the timer.
const sseHeartbeat = 25 * time.Second

// changeEvent is the whole SSE payload: a doorbell, not the data. A client that
// receives one (and did not cause it) refetches the roadmap in full. rev is a
// per-roadmap monotonic counter, useful only for debugging/ordering.
type changeEvent struct {
	RoadmapID int64  `json:"roadmapId"`
	Rev       int64  `json:"rev"`
	Origin    string `json:"origin"`
}

// hub fans "roadmap N changed" notifications out to the SSE subscribers of that
// roadmap. It is in-process: it reaches only clients connected to this replica,
// which matches the single-process assumption already baked into the snapshot
// throttle (see Server.lastAuto). The clean multi-replica upgrade is Postgres
// LISTEN/NOTIFY re-broadcasting into this same hub.
type hub struct {
	mu   sync.Mutex
	subs map[int64]map[chan changeEvent]struct{}
	rev  map[int64]int64
	// done is closed on server shutdown to release the SSE handlers: their
	// long-lived connections are never idle, so without this signal a graceful
	// srv.Shutdown blocks until its timeout (Shutdown does not cancel in-flight
	// request contexts). Wired via Server.Shutdown / http.Server.RegisterOnShutdown.
	done     chan struct{}
	closeOne sync.Once
}

func newHub() *hub {
	return &hub{
		subs: map[int64]map[chan changeEvent]struct{}{},
		rev:  map[int64]int64{},
		done: make(chan struct{}),
	}
}

// close signals every SSE handler to return. Idempotent: RegisterOnShutdown
// fires once, but a second call (e.g. a test) must not panic on a double close.
func (h *hub) close() {
	h.closeOne.Do(func() { close(h.done) })
}

func (h *hub) subscribe(roadmapID int64) chan changeEvent {
	ch := make(chan changeEvent, 16)
	h.mu.Lock()
	defer h.mu.Unlock()
	m := h.subs[roadmapID]
	if m == nil {
		m = map[chan changeEvent]struct{}{}
		h.subs[roadmapID] = m
	}
	m[ch] = struct{}{}
	return ch
}

func (h *hub) unsubscribe(roadmapID int64, ch chan changeEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if m := h.subs[roadmapID]; m != nil {
		delete(m, ch)
		if len(m) == 0 {
			delete(h.subs, roadmapID)
		}
	}
}

// broadcast delivers a change event to every subscriber of roadmapID. The send
// is non-blocking: a wedged client whose buffer is full simply misses this
// event, which is self-healing (the next event, or a reconnect, triggers a full
// refetch that reflects everything).
func (h *hub) broadcast(roadmapID int64, origin string) {
	h.mu.Lock()
	h.rev[roadmapID]++
	ev := changeEvent{RoadmapID: roadmapID, Rev: h.rev[roadmapID], Origin: origin}
	subs := make([]chan changeEvent, 0, len(h.subs[roadmapID]))
	for ch := range h.subs[roadmapID] {
		subs = append(subs, ch)
	}
	h.mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- ev:
		default: // slow consumer; drop — heals on the next event/reconnect
		}
	}
}

// handleEvents streams change notifications for one roadmap as Server-Sent
// Events. The browser's EventSource reconnects on its own, so this handler only
// has to serve one connection and exit cleanly when the client goes away.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // don't let nginx buffer the stream

	ch := s.hub.subscribe(id)
	defer s.hub.unsubscribe(id, ch)

	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	ticker := time.NewTicker(sseHeartbeat)
	defer ticker.Stop()
	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.hub.done: // server shutting down: release the connection
			return
		case ev := <-ch:
			b, err := json.Marshal(ev)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "data: %s\n\n", b)
			flusher.Flush()
		case <-ticker.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

// Shutdown releases the live SSE handlers so a graceful http.Server shutdown
// isn't stalled by their long-lived connections. Register it with
// srv.RegisterOnShutdown so it fires when Shutdown begins.
func (s *Server) Shutdown() {
	s.hub.close()
}

// statusRecorder captures the response status so the snap wrapper can broadcast
// a change only after a mutation actually succeeded (2xx).
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (w *statusRecorder) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}
