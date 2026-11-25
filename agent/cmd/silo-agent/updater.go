package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"silohq.io/agent/internal/tunnel"
	"silohq.io/agent/internal/update"
)

// errRestart: the agent took an update (or went back) and stops, for its launcher to start
// the binary to run now.
var errRestart = errors.New("restarting onto another binary")

// launch is `silo-agent run` as the installed binary runs it: the agent itself runs as a child
// process, the binary the update state names when it is later than this one and intact, else
// this one (internal/update/launch.go).
func launch(logger *slog.Logger, stateDir string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	self, err := os.Executable()
	if err != nil {
		return err
	}
	for {
		st, err := update.Load(stateDir)
		if err != nil {
			logger.Error(err.Error(), "event", "agent.update_state_unreadable")
			st = update.State{}
		}
		path, version := self, Version
		if cur := st.Current; cur != nil {
			switch {
			case update.Compare(cur.Version, Version) <= 0:
				logger.Info("the installed binary is as new as the update kept; it runs", "event", "agent.update_superseded", "version", Version)
			case !update.Intact(stateDir, cur):
				logger.Error("the update kept is missing or damaged; the installed binary runs", "event", "agent.update_damaged", "version", cur.Version)
			default:
				path, version = update.Path(stateDir, cur), cur.Version
			}
		}
		started := time.Now()
		code, err := update.RunChild(ctx, path, os.Args[1:], Version)
		if err != nil {
			return fmt.Errorf("cannot start the agent (%s): %w", version, err)
		}
		if ctx.Err() != nil {
			return nil
		}
		switch {
		case code == update.RestartCode:
			continue
		case code != 0 && path != self && time.Since(started) < update.FailWindow:
			// The update would not stay up: back to the binary before it, and the cell hears why.
			logger.Error("the updated agent did not stay up; going back to the binary before", "event", "agent.update_undone",
				"version", version, "exit_code", code)
			st.Back(update.RefusedFailedStart)
			if err := update.Save(stateDir, st); err != nil {
				return fmt.Errorf("cannot go back from a failed update: %w", err)
			}
			update.Prune(stateDir, st)
		case code == 0:
			return nil
		default:
			return fmt.Errorf("the agent (%s) exited with %d", version, code)
		}
	}
}

// updater asks the cell hourly whether to update (spec 10.7), and takes an update only when it
// checks out (internal/update).
type updater struct {
	logger   *slog.Logger
	stateDir string
	client   *tunnel.Client
	keys     update.Keys
	// sovereignKeys: a sovereign build's, for the agent-sovereign head.
	sovereignKeys update.Keys
	// base is the installed binary's version: what going back from the first update returns to.
	base    string
	restart func()
}

func (u *updater) run(ctx context.Context, first, every time.Duration) {
	timer := time.NewTimer(first)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		if u.once(ctx) {
			return
		}
		// Jittered, so a cell's agents do not all ask at once.
		timer.Reset(every - every/10 + time.Duration(rand.Int64N(int64(every/5)+1)))
	}
}

// once asks the cell what to do; true when the agent is restarting onto another binary.
func (u *updater) once(ctx context.Context) bool {
	st, err := update.Load(u.stateDir)
	if err != nil {
		u.logger.Error(err.Error(), "event", "agent.update_state_unreadable")
		return false
	}
	u.deliver(ctx, &st)
	res, done, err := u.client.Call(ctx, http.MethodGet, "/v1/update", nil)
	if err != nil {
		u.logger.Warn("cannot ask the cell about updates", "event", "agent.update_check_failed", "reason", err.Error())
		return false
	}
	var offer update.Offer
	err = json.NewDecoder(io.LimitReader(res.Body, 2<<20)).Decode(&offer)
	status := res.StatusCode
	done()
	if status != http.StatusOK || err != nil {
		u.logger.Warn("the cell's update answer was not one", "event", "agent.update_check_failed", "status", status)
		return false
	}
	switch offer.Action {
	case "update":
		return u.take(ctx, &st, offer)
	case "rollback":
		return u.back(ctx, &st, offer)
	}
	return false
}

func (u *updater) take(ctx context.Context, st *update.State, o update.Offer) bool {
	if reason := update.Check(o, u.keys, update.Want{
		Channel: updateChannel, Target: updateTarget, SovereignKeys: u.sovereignKeys, Platform: platform(), Running: Version, Failed: st.Failed,
	}); reason != "" {
		u.refuse(ctx, st, o.Version, "refused", reason)
		return false
	}
	res, done, err := u.client.Call(ctx, http.MethodGet, "/v1/update/binary/"+strings.TrimPrefix(o.Digest, "sha256:"), nil)
	if err != nil {
		u.logger.Warn("cannot download the update", "event", "agent.update_download_failed", "version", o.Version, "reason", err.Error())
		return false
	}
	defer done()
	if res.StatusCode != http.StatusOK {
		u.logger.Warn("the cell did not send the update", "event", "agent.update_download_failed", "version", o.Version, "status", res.StatusCode)
		return false
	}
	entry, err := update.Receive(u.stateDir, o, res.Body)
	switch {
	case errors.Is(err, update.ErrDigest):
		u.refuse(ctx, st, o.Version, "refused", update.RefusedDigest)
		return false
	case update.IsStorage(err):
		u.refuse(ctx, st, o.Version, "refused", update.RefusedStorage)
		return false
	case err != nil:
		u.logger.Warn("the update's download broke off", "event", "agent.update_download_failed", "version", o.Version)
		return false
	}
	st.Take(entry)
	if err := update.Save(u.stateDir, *st); err != nil {
		u.refuse(ctx, st, o.Version, "refused", update.RefusedStorage)
		return false
	}
	update.Prune(u.stateDir, *st)
	u.logger.Info("update checked and kept; restarting onto it", "event", "agent.update_taken", "from", Version, "to", o.Version)
	u.restart()
	return true
}

// back goes to the binary run before this one, when the cell says this one's wave failed.
func (u *updater) back(ctx context.Context, st *update.State, o update.Offer) bool {
	before := u.base
	if st.Previous != nil {
		before = st.Previous.Version
	}
	if st.Current == nil || st.Current.Version != Version || o.Version != before {
		u.refuse(ctx, st, o.Version, "refused", update.RefusedNoPrevious)
		return false
	}
	st.Back("")
	if err := update.Save(u.stateDir, *st); err != nil {
		u.logger.Error("cannot go back", "event", "agent.update_back_failed", "reason", err.Error())
		return false
	}
	update.Prune(u.stateDir, *st)
	u.logger.Warn("the cell's wave failed its gates; going back to the binary before", "event", "agent.update_back", "from", Version, "to", before)
	u.restart()
	return true
}

// refuse tells the cell (agent_update_refused); kept to send again if it cannot be told now.
func (u *updater) refuse(ctx context.Context, st *update.State, version, outcome, reason string) {
	u.logger.Warn("update refused", "event", "agent.update_refused", "version", version, "reason", reason)
	report := update.Report{Version: version, Outcome: outcome, Reason: reason}
	if !u.send(ctx, report) {
		st.Pending = append(st.Pending, report)
		_ = update.Save(u.stateDir, *st)
	}
}

// deliver sends the reports kept: an update undone by the launcher, a refusal not yet told.
func (u *updater) deliver(ctx context.Context, st *update.State) {
	if len(st.Pending) == 0 {
		return
	}
	var left []update.Report
	for _, r := range st.Pending {
		if !u.send(ctx, r) {
			left = append(left, r)
		}
	}
	st.Pending = left
	_ = update.Save(u.stateDir, *st)
}

func (u *updater) send(ctx context.Context, r update.Report) bool {
	res, done, err := u.client.Call(ctx, http.MethodPost, "/v1/update/report", r)
	if err != nil {
		return false
	}
	defer done()
	return res.StatusCode == http.StatusOK
}
