package store

import (
	"context"
	"time"

	"github.com/dnswlt/roadie/internal/model"
)

// Seed creates a demo roadmap with a few lanes and items if the database
// holds no roadmaps yet. Dates are relative to today so the demo always
// shows a plausible planning horizon.
func (s *Store) Seed(ctx context.Context) error {
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT COUNT(*) FROM roadmaps`).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}

	rm, err := s.CreateRoadmap(ctx, "Platform Roadmap")
	if err != nil {
		return err
	}

	today := time.Now()
	monthStart := time.Date(today.Year(), today.Month(), 1, 0, 0, 0, 0, time.UTC)
	d := func(months int, day int) model.Date {
		return model.NewDate(monthStart.AddDate(0, months, day-1))
	}

	type seedItem struct {
		title      string
		desc       string
		start, end model.Date
		children   []seedItem
	}
	type seedMilestone struct {
		title string
		desc  string
		date  model.Date
	}
	lanes := []struct {
		name       string
		items      []seedItem
		milestones []seedMilestone
	}{
		{"Core Platform", []seedItem{
			{title: "API Gateway v2",
				desc:  "Replace the legacy gateway with the new routing layer. Spec: https://wiki.example.com/gateway-v2",
				start: d(-1, 1), end: d(2, 28), children: []seedItem{
					{title: "Design & spike", start: d(-1, 1), end: d(-1, 21)},
					{title: "Migration", start: d(0, 1), end: d(1, 28)},
					{title: "Decommission legacy", start: d(2, 1), end: d(2, 28)},
				}},
			{title: "Observability stack", desc: "Tracing and unified dashboards.",
				start: d(1, 1), end: d(4, 15)},
		}, []seedMilestone{
			{title: "Gateway cutover", desc: "All traffic on the new gateway.", date: d(2, 1)},
		}},
		{"Product", []seedItem{
			{title: "Self-service onboarding",
				desc:  "Reduce time-to-first-value to under 10 minutes. Tracking: https://issues.example.com/browse/PLAT-142",
				start: d(0, 10), end: d(3, 20), children: []seedItem{
					{title: "Signup flow", start: d(0, 10), end: d(1, 15)},
					{title: "Guided setup", start: d(1, 10), end: d(3, 20)},
				}},
			{title: "Enterprise SSO", start: d(3, 1), end: d(5, 30)},
		}, []seedMilestone{
			{title: "Public beta", date: d(1, 15)},
			{title: "GA launch", desc: "General availability.", date: d(4, 1)},
		}},
		{"Team & Enablement", []seedItem{
			{title: "Kubernetes upskilling", desc: "Continuous learning track for all backend teams.",
				start: d(-1, 1), end: d(6, 28)},
			{title: "Hiring: 2 senior engineers", start: d(0, 1), end: d(2, 28)},
		}, nil},
	}

	for _, ln := range lanes {
		lane, err := s.CreateLane(ctx, rm.ID, ln.name)
		if err != nil {
			return err
		}
		for _, si := range ln.items {
			parent, err := s.CreateItem(ctx, lane.ID, NewItem{
				Title: si.title, Description: si.desc,
				StartDate: si.start, EndDate: si.end,
			})
			if err != nil {
				return err
			}
			for _, ci := range si.children {
				if _, err := s.CreateItem(ctx, lane.ID, NewItem{
					Title: ci.title, Description: ci.desc,
					StartDate: ci.start, EndDate: ci.end,
					ParentID: &parent.ID,
				}); err != nil {
					return err
				}
			}
		}
		for _, ms := range ln.milestones {
			if _, err := s.CreateMilestone(ctx, lane.ID, NewMilestone{
				Title: ms.title, Description: ms.desc, Date: ms.date,
			}); err != nil {
				return err
			}
		}
	}
	return nil
}
