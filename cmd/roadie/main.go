package main

import (
	"context"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/dnswlt/roadie/internal/auth"
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
	authMode := flag.String("auth", "off", `authentication mode: "off" (everyone may edit anonymously) or "oidc"`)
	redirectURL := flag.String("oidc-redirect-url", "", "public URL of this server's /auth/callback (required with -auth=oidc)")
	sessionTTL := flag.Duration("session-ttl", auth.DefaultSessionTTL, "how long a login lasts before re-authentication")
	insecureTLS := flag.Bool("oidc-insecure-tls", false, "skip TLS verification when talking to the OIDC provider (local mocks only, never in production)")
	authDebug := flag.Bool("auth-debug", envBool("AUTH_DEBUG"),
		"log every claim the OIDC provider sends (personal data: for diagnosing a provider, not for normal running); also settable as AUTH_DEBUG")
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
	opts, err := authOptions(ctx, *authMode, *redirectURL, *sessionTTL, *insecureTLS, *authDebug)
	if err != nil {
		return err
	}

	app := server.New(st, static, opts...)
	srv := &http.Server{
		Addr:              *addr,
		Handler:           app,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	// Long-lived SSE connections are never idle, so without a nudge they'd block
	// srv.Shutdown until its timeout. This fires when Shutdown begins and tells
	// the SSE handlers to return, letting their connections drain immediately.
	srv.RegisterOnShutdown(app.Shutdown)

	// Register the signal handler before serving so a fast SIGTERM isn't missed.
	// It also bounds the trash sweeper below.
	// k8s sends it on rollouts, scale-down, and node drains, then SIGKILLs after
	// the grace period — so drain in-flight requests instead of dropping them.
	sigCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Purge roadmaps that have outstayed their time in the trash. Bounded by
	// sigCtx, so it stops with the rest of the process; nothing waits for it,
	// since its work is a single statement that either commits or doesn't.
	go app.RunTrashSweeper(sigCtx)

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

// authOptions resolves the -auth mode into server options.
//
// The mode is an explicit flag rather than something inferred from whether the
// OIDC environment happens to be set: a typo in OIDC_ISSUER must fail startup,
// not quietly leave the server unauthenticated. Everything except the mode and
// the public callback URL comes from the environment, because flag values are
// visible to anyone who can run ps.
func authOptions(ctx context.Context, mode, redirectURL string, ttl time.Duration, insecureTLS, debug bool) ([]server.Option, error) {
	switch mode {
	case "off":
		log.Print("auth: DISABLED — all requests are anonymous and may edit everything")
		return nil, nil
	case "oidc":
	default:
		return nil, fmt.Errorf("invalid -auth %q (want \"off\" or \"oidc\")", mode)
	}

	key, err := sessionKey()
	if err != nil {
		return nil, err
	}
	issuer := os.Getenv("OIDC_ISSUER")
	clientID := os.Getenv("OIDC_CLIENT_ID")
	a, err := auth.New(ctx, auth.Config{
		Issuer:       issuer,
		ClientID:     clientID,
		ClientSecret: os.Getenv("OIDC_CLIENT_SECRET"),
		RedirectURL:  redirectURL,
		SessionKey:   key,
		SessionTTL:   ttl,
		InsecureTLS:  insecureTLS,
		Debug:        debug,
	})
	if err != nil {
		return nil, fmt.Errorf("auth: %w", err)
	}
	if insecureTLS {
		log.Print("auth: WARNING — TLS verification to the OIDC provider is disabled")
	}
	if debug {
		log.Print("auth: WARNING — claim debug logging is on; provider claim values (names, addresses) will be written to the log")
	}
	// The redirect URL is logged in full because the provider must have the
	// byte-identical string registered, and its path is where Roadie serves the
	// callback: a mismatch shows up as a provider-side error or a 404 here, and
	// this line is what you compare against the app registration.
	log.Printf("auth: oidc (issuer=%s, client=%s, redirect=%s, session=%s)", issuer, clientID, redirectURL, ttl)
	return []server.Option{server.WithAuth(a)}, nil
}

// sessionKey reads the 32-byte cookie sealing key from SESSION_KEY, e.g.
// `openssl rand -base64 32`. Generating one when it is unset keeps a
// single-instance deployment working out of the box, at the cost of logging
// everyone out on restart — and of being wrong for more than one replica,
// which is why it warns.
func sessionKey() ([]byte, error) {
	raw := strings.TrimSpace(os.Getenv("SESSION_KEY"))
	if raw == "" {
		log.Print("auth: WARNING — SESSION_KEY is unset; using a random key, so sessions end at restart and cannot be shared between replicas")
		return auth.NewSessionKey(), nil
	}
	key, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("SESSION_KEY is not valid base64: %w", err)
	}
	return key, nil
}

// envBool reads a boolean toggle for use as a flag's default, so a container's
// environment can set it (`oc set env`) without touching its arguments. A bad
// value warns instead of failing startup, but must not pass silently: "I set
// the variable and nothing happened" is what this exists to avoid.
func envBool(name string) bool {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return false
	}
	v, err := strconv.ParseBool(raw)
	if err != nil {
		log.Printf("WARNING — ignoring %s=%q: not a boolean (want 1/0, true/false)", name, raw)
		return false
	}
	return v
}
