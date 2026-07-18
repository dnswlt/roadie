package main

import (
	"context"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"

	"github.com/dnswlt/roadie/internal/server"
	"github.com/dnswlt/roadie/internal/store"
	"github.com/dnswlt/roadie/web"
)

func main() {
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
		log.Fatal(err)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		log.Fatal(err)
	}
	if *seed {
		if err := st.Seed(ctx); err != nil {
			log.Fatal(err)
		}
	}

	var static fs.FS
	if *dev {
		static = os.DirFS("web/dist")
	} else {
		static, err = fs.Sub(web.Dist, "dist")
		if err != nil {
			log.Fatal(err)
		}
	}

	log.Printf("roadie listening on http://%s", *addr)
	if err := http.ListenAndServe(*addr, server.New(st, static)); err != nil {
		log.Fatal(err)
	}
}
