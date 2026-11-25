// Package values turns what the Postgres driver decodes into what the cell reads: numbers
// that fit a double, text for numerics (whose digits a double would lose), times as RFC 3339,
// bytes as Postgres's hex form. Reads and change capture use it alike.
package values

import (
	"encoding/hex"
	"fmt"
	"math/big"
	"net/netip"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// DateOID is Postgres's date type, which the driver decodes as a time.
const DateOID = 1082

// ForColumn is the value of a column of this type as the cell reads it: a date is a calendar
// date, never a moment.
func ForColumn(oid uint32, v any) any {
	if t, ok := v.(time.Time); ok && oid == DateOID {
		return t.Format("2006-01-02")
	}
	return JSON(v)
}

// JSON is the value as the cell reads it.
func JSON(v any) any {
	switch t := v.(type) {
	case nil, bool, string, int16, int32, float32, float64:
		return t
	case int64:
		if t > 1<<53 || t < -(1<<53) {
			return fmt.Sprint(t)
		}
		return t
	case pgtype.Numeric:
		if !t.Valid {
			return nil
		}
		if t.NaN {
			return "NaN"
		}
		value, err := t.Value()
		if err != nil {
			return nil
		}
		return value
	case *big.Int:
		return t.String()
	case time.Time:
		// As the cell's own Postgres reads give it: UTC, to the millisecond.
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	case []byte:
		return "\\x" + hex.EncodeToString(t)
	case [16]byte:
		return fmt.Sprintf("%x-%x-%x-%x-%x", t[0:4], t[4:6], t[6:8], t[8:10], t[10:16])
	case netip.Prefix:
		return t.String()
	case map[string]any, []any:
		return t
	case fmt.Stringer:
		return t.String()
	default:
		return fmt.Sprint(t)
	}
}
