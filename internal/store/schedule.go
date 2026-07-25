package store

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/dnswlt/roadie/internal/model"
)

const schedulePeriodCols = "id, label, start_date, end_date"

func scanSchedulePeriod(r rowScanner) (model.SchedulePeriod, error) {
	var p model.SchedulePeriod
	var start, end time.Time
	if err := r.Scan(&p.ID, &p.Label, &start, &end); err != nil {
		return model.SchedulePeriod{}, err
	}
	p.StartDate = model.NewDate(start)
	p.EndDate = model.NewDate(end)
	return p, nil
}

// getSchedule reads a roadmap's schedule periods, ordered by start date. Shared
// by getRoadmapFull and ReplaceSchedule (to return the stored result).
func getSchedule(ctx context.Context, q querier, roadmapID int64) ([]model.SchedulePeriod, error) {
	rows, err := q.Query(ctx,
		`SELECT `+schedulePeriodCols+` FROM schedule_periods WHERE roadmap_id = $1 ORDER BY start_date, id`,
		roadmapID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	periods := []model.SchedulePeriod{}
	for rows.Next() {
		p, err := scanSchedulePeriod(rows)
		if err != nil {
			return nil, err
		}
		periods = append(periods, p)
	}
	return periods, rows.Err()
}

// validateSchedulePeriods enforces a schedule's invariants: non-empty labels,
// present dates, end >= start, and no overlapping periods. Periods are inclusive
// [start, end]; two are disjoint iff the later one starts after the earlier one
// ends. Order is irrelevant (periods are positioned by date), so it sorts a copy
// by start date to check neighbours.
func validateSchedulePeriods(periods []model.SchedulePeriod) error {
	sorted := make([]model.SchedulePeriod, len(periods))
	copy(sorted, periods)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].StartDate.Before(sorted[j].StartDate.Time)
	})
	for i, p := range sorted {
		if strings.TrimSpace(p.Label) == "" {
			return invalidf("schedule period label must not be empty")
		}
		if p.StartDate.IsZero() || p.EndDate.IsZero() {
			return invalidf("schedule period %q is missing a start or end date", p.Label)
		}
		if p.EndDate.Before(p.StartDate.Time) {
			return invalidf("schedule period %q end date must not be before start date", p.Label)
		}
		if i > 0 && !p.StartDate.After(sorted[i-1].EndDate.Time) {
			return invalidf("schedule periods %q and %q overlap", sorted[i-1].Label, p.Label)
		}
	}
	return nil
}

// insertSchedulePeriods validates and writes periods for roadmapID within tx. It
// assumes the roadmap has no periods yet (a fresh import target, or one just
// cleared). Shared by insertRoadmapContents and ReplaceSchedule.
func insertSchedulePeriods(ctx context.Context, tx pgx.Tx, roadmapID int64, periods []model.SchedulePeriod) error {
	if err := validateSchedulePeriods(periods); err != nil {
		return err
	}
	for _, p := range periods {
		if _, err := tx.Exec(ctx,
			`INSERT INTO schedule_periods (roadmap_id, label, start_date, end_date) VALUES ($1, $2, $3, $4)`,
			roadmapID, strings.TrimSpace(p.Label), p.StartDate.Time, p.EndDate.Time); err != nil {
			return err
		}
	}
	return nil
}

// SchedulePeriodInput is one incoming period for ReplaceSchedule. IDs are
// assigned by the store; the client sends only label + dates.
type SchedulePeriodInput struct {
	Label     string     `json:"label"`
	StartDate model.Date `json:"startDate"`
	EndDate   model.Date `json:"endDate"`
}

// ReplaceSchedule replaces a roadmap's entire schedule with the given periods
// (an empty list clears it). It validates labels/dates and rejects overlaps,
// running in one transaction under the roadmap lock so it can't race a
// concurrent restore. Returns the stored periods, ordered by start date.
func (s *Store) ReplaceSchedule(ctx context.Context, roadmapID int64, in []SchedulePeriodInput) ([]model.SchedulePeriod, error) {
	periods := make([]model.SchedulePeriod, len(in))
	for i, p := range in {
		periods[i] = model.SchedulePeriod{Label: p.Label, StartDate: p.StartDate, EndDate: p.EndDate}
	}
	if err := validateSchedulePeriods(periods); err != nil {
		return nil, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	if err := s.lockRoadmap(ctx, tx, roadmapID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM schedule_periods WHERE roadmap_id = $1`, roadmapID); err != nil {
		return nil, err
	}
	if err := insertSchedulePeriods(ctx, tx, roadmapID, periods); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return getSchedule(ctx, s.pool, roadmapID)
}
