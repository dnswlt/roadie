package sheet

import (
	"time"

	"github.com/dnswlt/roadie/internal/model"
)

const secondsPerDay = 24 * 60 * 60

// Spans are computed in day numbers (days since the Unix epoch, UTC), the same
// integer domain the frontend uses, so overlaps and column widths are plain
// arithmetic.
//
// Cells get Excel serial numbers instead, computed from the calendar date and
// never from a time.Time: a date that never becomes an instant cannot be
// shifted by a time zone.

// dayOf converts a calendar date to its day number. model.Date is always UTC
// midnight, so its Unix seconds are an exact multiple of a day and the division
// is exact on both sides of the epoch.
func dayOf(d model.Date) int {
	return int(d.Time.Unix() / secondsPerDay)
}

func dateOf(day int) model.Date {
	return model.NewDate(time.Unix(int64(day)*secondsPerDay, 0).UTC())
}

// excelEpochOffset is 1970-01-01 as an Excel date serial: serials count days
// since 1899-12-30.
const excelEpochOffset = 25569

func dateSerial(d model.Date) int {
	return dayOf(d) + excelEpochOffset
}

// timeSerial is dateSerial with the time of day as the fraction, for a real
// datetime cell.
func timeSerial(t time.Time) float64 {
	utc := t.UTC()
	day := model.NewDate(utc)
	secs := utc.Sub(day.Time).Seconds()
	return float64(dateSerial(day)) + secs/secondsPerDay
}

// monthStart returns the first day of the month `offset` months from the one
// containing `day`.
func monthStart(day, offset int) int {
	t := time.Unix(int64(day)*secondsPerDay, 0).UTC()
	return dayOf(model.NewDate(time.Date(t.Year(), t.Month()+time.Month(offset), 1, 0, 0, 0, 0, time.UTC)))
}

// yearStart returns 1 January of the year `offset` years from the one
// containing `day`.
func yearStart(day, offset int) int {
	t := time.Unix(int64(day)*secondsPerDay, 0).UTC()
	return dayOf(model.NewDate(time.Date(t.Year()+offset, time.January, 1, 0, 0, 0, 0, time.UTC)))
}

// quarterStart returns the first day of the quarter `offset` quarters from the
// one containing `day`.
func quarterStart(day, offset int) int {
	t := time.Unix(int64(day)*secondsPerDay, 0).UTC()
	q := (int(t.Month())-1)/3*3 + 1
	return dayOf(model.NewDate(time.Date(t.Year(), time.Month(q+3*offset), 1, 0, 0, 0, 0, time.UTC)))
}
