package work

import (
	"testing"
	"time"
)

func TestOracleValuesAsTheCellReadsThem(t *testing.T) {
	wall := time.Date(2026, 11, 3, 0, 0, 0, 0, time.FixedZone("server", 3600))
	cases := []struct {
		name, typ string
		value     any
		want      any
	}{
		{"null", "NUMBER", nil, nil},
		{"a whole number is a number", "NUMBER", "1", int64(1)},
		{"a decimal keeps its digits", "NUMBER", "10.5", "10.5"},
		{"a whole number beyond a double keeps its digits", "NUMBER", "123456789012345678901", "123456789012345678901"},
		{"a DATE is its wall clock in UTC", "DATE", wall, "2026-11-03T00:00:00.000Z"},
		{"a TIMESTAMP likewise", "TIMESTAMP", time.Date(2026, 11, 1, 10, 0, 0, 250_000_000, time.UTC), "2026-11-01T10:00:00.250Z"},
		{"RAW is hex", "RAW", []byte{0xca, 0xfe}, `\xcafe`},
		{"text is text", "NCHAR", "north", "north"},
	}
	for _, c := range cases {
		if got := oracleValue(c.typ, c.value); got != c.want {
			t.Errorf("%s: got %#v, want %#v", c.name, got, c.want)
		}
	}
}
