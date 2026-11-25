package values

import (
	"encoding/hex"
	"fmt"
	"time"
)

// SQLServer is a SQL Server column's value as the cell reads it: decimals and money as their digits,
// moments in UTC to the millisecond (a datetime without an offset taken as UTC), dates as dates,
// a uniqueidentifier as its text, binary as hex.
func SQLServer(typeName string, v any) any {
	if v == nil {
		return nil
	}
	switch typeName {
	case "DECIMAL", "NUMERIC", "MONEY", "SMALLMONEY":
		if b, ok := v.([]byte); ok {
			return string(b)
		}
	case "UNIQUEIDENTIFIER":
		if b, ok := v.([]byte); ok && len(b) == 16 {
			// SQL Server sends the first three groups little-endian.
			return fmt.Sprintf("%02x%02x%02x%02x-%02x%02x-%02x%02x-%x-%x", b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6], b[8:10], b[10:16])
		}
	case "DATE":
		if t, ok := v.(time.Time); ok {
			return t.Format("2006-01-02")
		}
	case "TIME":
		if t, ok := v.(time.Time); ok {
			return t.Format("15:04:05.000")
		}
	case "BINARY", "VARBINARY", "IMAGE", "TIMESTAMP", "ROWVERSION":
		if b, ok := v.([]byte); ok {
			return "\\x" + hex.EncodeToString(b)
		}
	}
	if b, ok := v.([]byte); ok {
		return string(b)
	}
	return JSON(v)
}
