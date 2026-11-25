package work

import "testing"

func TestSingleSelect(t *testing.T) {
	for text, want := range map[string]bool{
		"select [id] from [sales].[orders] where [id] = @p1": true,
		"  SELECT 1;": true,
		"with x as (select 1 as a) select a from x":        true,
		"update [sales].[orders] set amount = 0":           false,
		"select 1; update [sales].[orders] set amount = 0": false,
		"exec sp_who":         false,
		"select 1;\nselect 2": false,
	} {
		if got := singleSelect(text); got != want {
			t.Errorf("%q: got %v", text, got)
		}
	}
}
