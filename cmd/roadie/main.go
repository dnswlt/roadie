package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/dnswlt/roadie/internal/server"
	"github.com/dnswlt/roadie/internal/store"
	"github.com/dnswlt/roadie/web"
)

// main keeps run's defers (st.Close, signal reset) in play by handling the exit
// itself: log.Fatal calls os.Exit, which skips defers, so only main may call it
// — after run has returned and unwound. A non-nil error also gives a non-zero
// exit, so a failed startup reads as a failure to k8s and monitoring.
func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	addr := flag.String("addr", "localhost:8080", "listen address")
	dev := flag.Bool("dev", false, "serve frontend from web/dist on disk instead of the embedded copy")
	seed := flag.Bool("seed", false, "create a demo roadmap if the database is empty")
	flag.Parse()

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://roadie:roadie@localhost:5433/roadie"
	}

	ctx := context.Background()
	st, err := store.Connect(ctx, dbURL)
	if err != nil {
		return err
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		return err
	}
	if *seed {
		if err := st.Seed(ctx); err != nil {
			return err
		}
	}

	var static fs.FS
	if *dev {
		static = os.DirFS("web/dist")
	} else {
		static, err = fs.Sub(web.Dist, "dist")
		if err != nil {
			return err
		}
	}

	// Timeouts bound how long a client can tie up a connection. ReadHeaderTimeout
	// in particular defends against Slowloris (a peer that dribbles headers
	// forever). No global WriteTimeout on purpose: it caps the entire response
	// write, which would sever long-lived SSE streams. If a non-streaming route
	// ever needs slow-read protection, set a per-connection deadline in that
	// handler via http.NewResponseController(w).SetWriteDeadline.
	srv := &http.Server{
		Addr:              *addr,
		Handler:           server.New(st, static),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	// Register the signal handler before serving so a fast SIGTERM isn't missed.
	// k8s sends it on rollouts, scale-down, and node drains, then SIGKILLs after
	// the grace period — so drain in-flight requests instead of dropping them.
	sigCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Serve in the background; block until we're told to stop or serving fails
	// to start (e.g. the port is taken), whichever comes first.
	errCh := make(chan error, 1)
	go func() {
		log.Printf("roadie listening on http://%s", *addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return fmt.Errorf("serve: %w", err)
	case <-sigCtx.Done():
	}
	stop() // restore default handling, so a second signal force-quits a stuck drain

	log.Println("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	return nil
}
