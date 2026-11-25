package work

import (
	"testing"

	"github.com/go-mysql-org/go-mysql/mysql"
)

func TestMySQLValuesAsTheCellReadsThem(t *testing.T) {
	text := func(s string) mysql.FieldValue { return mysql.NewFieldValue(mysql.FieldValueTypeString, 0, []byte(s)) }
	field := func(typ uint8, charset uint16) *mysql.Field { return &mysql.Field{Type: typ, Charset: charset} }
	cases := []struct {
		name  string
		field *mysql.Field
		value mysql.FieldValue
		want  any
	}{
		{"null", field(mysql.MYSQL_TYPE_LONG, 63), mysql.NewFieldValue(mysql.FieldValueTypeNull, 0, nil), nil},
		{"a signed integer", field(mysql.MYSQL_TYPE_LONGLONG, 63), mysql.NewFieldValue(mysql.FieldValueTypeSigned, uint64(1<<62), nil), "4611686018427387904"},
		{"an unsigned integer beyond a double", field(mysql.MYSQL_TYPE_LONGLONG, 63), mysql.NewFieldValue(mysql.FieldValueTypeUnsigned, 1<<63, nil), "9223372036854775808"},
		{"a small unsigned integer", field(mysql.MYSQL_TYPE_LONG, 63), mysql.NewFieldValue(mysql.FieldValueTypeUnsigned, 7, nil), int64(7)},
		{"a decimal keeps its digits", field(mysql.MYSQL_TYPE_NEWDECIMAL, 63), text("12345678901234567890.12"), "12345678901234567890.12"},
		{"a datetime is a moment in UTC", field(mysql.MYSQL_TYPE_DATETIME, 63), text("2026-11-01 10:00:00.250000"), "2026-11-01T10:00:00.250Z"},
		{"a zero datetime has none", field(mysql.MYSQL_TYPE_DATETIME, 63), text("0000-00-00 00:00:00"), nil},
		{"a date is a date", field(mysql.MYSQL_TYPE_DATE, 63), text("2026-11-03"), "2026-11-03"},
		{"a zero date has none", field(mysql.MYSQL_TYPE_DATE, 63), text("0000-00-00"), nil},
		{"binary is hex", field(mysql.MYSQL_TYPE_VAR_STRING, 63), text("\xca\xfe"), `\xcafe`},
		{"text is text", field(mysql.MYSQL_TYPE_VAR_STRING, 255), text("north"), "north"},
		{"a bit is a number", field(mysql.MYSQL_TYPE_BIT, 63), text("\x01\x00"), int64(256)},
	}
	for _, c := range cases {
		v := c.value
		if got := mysqlValue(c.field, &v); got != c.want {
			t.Errorf("%s: got %#v, want %#v", c.name, got, c.want)
		}
	}
	if args := mysqlArgs([]any{true, false, "x", int64(1)}); args[0] != int64(1) || args[1] != int64(0) || args[2] != "x" {
		t.Errorf("booleans bind as 1 and 0: %#v", args)
	}
}
