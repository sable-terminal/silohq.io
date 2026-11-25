package values

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

func TestValuesAsTheCellReadsThem(t *testing.T) {
	at := time.Date(2026, 11, 1, 11, 0, 0, 123456000, time.FixedZone("x", 3600))
	cases := []struct {
		name string
		got  any
		want any
	}{
		{"a moment, UTC to the millisecond", JSON(at), "2026-11-01T10:00:00.123Z"},
		{"a date column, a calendar date", ForColumn(DateOID, time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)), "2026-11-01"},
		{"an integer beyond a double, text", JSON(int64(1) << 60), "1152921504606846976"},
		{"a small integer, a number", JSON(int64(42)), int64(42)},
		{"bytes, Postgres's hex", JSON([]byte{0xde, 0xad}), `\xdead`},
		{"a uuid", JSON([16]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}), "01020304-0506-0708-090a-0b0c0d0e0f10"},
		{"null", JSON(nil), nil},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s: got %#v, want %#v", c.name, c.got, c.want)
		}
	}
	var n pgtype.Numeric
	if err := n.Scan("12345678901234567890.123"); err != nil {
		t.Fatal(err)
	}
	if got := JSON(n); got != "12345678901234567890.123" {
		t.Errorf("a numeric keeps its digits as text: got %#v", got)
	}
}
