package store

import (
	"context"
	"embed"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// migrateLockKey is an arbitrary but stable key for the advisory lock that
// serializes concurrent Migrate calls (e.g. several replicas booting at once),
// so they can't race to apply schema changes. Only Migrate uses it.
const migrateLockKey = 0x726f6164 // "road"

//go:embed migrations/*.sql
var migrationFS embed.FS

// schemaSQL is the consolidated current schema, used to build fresh databases
// in one step. See schema.sql and Migrate.
//
//go:embed schema.sql
var schemaSQL string

type migration struct {
	version int
	name    string
}

// migrationEntries returns the embedded migrations sorted ascending by version.
// Files are named NNN_description.sql.
func migrationEntries() ([]migration, error) {
	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	migs := make([]migration, 0, len(entries))
	for _, e := range entries {
		name := e.Name()
		version, err := strconv.Atoi(strings.SplitN(name, "_", 2)[0])
		if err != nil {
			return nil, fmt.Errorf("migration %s: name must start with a number", name)
		}
		migs = append(migs, migration{version: version, name: name})
	}
	return migs, nil
}

// checkNoPrunedGap rejects a database that is too old for the migrations still
// on disk: if pruned files leave a gap between the DB's history and the oldest
// survivor, applying the survivors would corrupt it. migs must be sorted
// ascending; applied is a contiguous prefix.
func checkNoPrunedGap(applied map[int]bool, migs []migration) error {
	maxApplied := 0
	for v := range applied {
		if v > maxApplied {
			maxApplied = v
		}
	}
	// The lowest pending version must sit directly on top of maxApplied.
	for _, m := range migs {
		if applied[m.version] {
			continue
		}
		if m.version > maxApplied+1 {
			return fmt.Errorf(
				"database is at version %d but migrations up to %d are missing "+
					"(pruned?); cannot upgrade this database", maxApplied, m.version-1)
		}
		break
	}
	return nil
}

// Migrate brings the database schema up to date. A fresh database (nothing in
// schema_migrations) is built from schema.sql and all migrations marked
// applied; an existing one gets the pending numbered migrations in order.
//
// The whole thing runs under a session-level advisory lock held on a single
// dedicated connection, so concurrent callers (multiple replicas starting up)
// serialize: the first applies the schema, the rest wait, then find nothing to
// do. Running the migration on the held connection — rather than fresh pool
// connections — also keeps it deadlock-free when the pool is tiny. A crashed
// process drops the lock automatically when its connection closes.
func (s *Store) Migrate(ctx context.Context) error {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, int64(migrateLockKey)); err != nil {
		return fmt.Errorf("acquire migration lock: %w", err)
	}
	// Release on a fresh context so an already-cancelled ctx still unlocks.
	defer conn.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, int64(migrateLockKey))

	return migrate(ctx, conn)
}

// migrate runs the migration steps on a single connection. Callers hold the
// advisory lock; see Migrate.
func migrate(ctx context.Context, conn *pgxpool.Conn) error {
	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version INT PRIMARY KEY,
		applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	applied := map[int]bool{}
	rows, err := conn.Query(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var v int
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return err
		}
		applied[v] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	migs, err := migrationEntries()
	if err != nil {
		return err
	}

	// Fresh database: build from schema.sql, then mark every migration applied.
	if len(applied) == 0 {
		tx, err := conn.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, schemaSQL); err != nil {
			return fmt.Errorf("apply schema.sql: %w", err)
		}
		for _, m := range migs {
			if _, err := tx.Exec(ctx,
				`INSERT INTO schema_migrations (version) VALUES ($1)`, m.version); err != nil {
				return err
			}
		}
		return tx.Commit(ctx)
	}

	// Existing database: apply pending migrations in ascending order.
	if err := checkNoPrunedGap(applied, migs); err != nil {
		return err
	}

	for _, m := range migs {
		if applied[m.version] {
			continue
		}
		sql, err := migrationFS.ReadFile("migrations/" + m.name)
		if err != nil {
			return err
		}
		tx, err := conn.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("apply migration %s: %w", m.name, err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO schema_migrations (version) VALUES ($1)`, m.version); err != nil {
			tx.Rollback(ctx)
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
	}
	return nil
}
