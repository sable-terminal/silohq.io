package values

import (
	"testing"
	"time"
)

func TestSQLServerValuesAsTheCellReadsThem(t *testing.T) {
	at := time.Date(2026, 11, 1, 10, 0, 0, 250_000_000, time.UTC)
	cases := []struct {
		name, typ string
		value     any
		want      any
	}{
		{"null", "INT", nil, nil},
		{"a decimal keeps its digits", "DECIMAL", []byte("12345678901234567890.12"), "12345678901234567890.12"},
		{"money keeps its digits", "MONEY", []byte("10.5000"), "10.5000"},
		{"a uniqueidentifier, its first groups turned", "UNIQUEIDENTIFIER", []byte{0x04, 0x03, 0x02, 0x01, 0x06, 0x05, 0x08, 0x07, 9, 10, 11, 12, 13, 14, 15, 16},
			"01020304-0506-0708-090a-0b0c0d0e0f10"},
		{"a date is a date", "DATE", at, "2026-11-01"},
		{"a datetime2 is a moment", "DATETIME2", at, "2026-11-01T10:00:00.250Z"},
		{"binary is hex", "VARBINARY", []byte{0xca, 0xfe}, `\xcafe`},
		{"text is text", "NVARCHAR", "north", "north"},
		{"a bit is a boolean", "BIT", true, true},
		{"an integer is a number", "BIGINT", int64(42), int64(42)},
	}
	for _, c := range cases {
		if got := SQLServer(c.typ, c.value); got != c.want {
			t.Errorf("%s: got %#v, want %#v", c.name, got, c.want)
		}
	}
}
