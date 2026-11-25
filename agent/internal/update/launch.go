package update

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"time"
)

// The installed binary is a launcher: `silo-agent run` starts the agent as a child process,
// the binary the state names if it is later than the installed one and intact, else itself.
// A child that took an update exits with RestartCode, and the launcher starts the binary to run
// now; one that exits with a failure within FailWindow of starting an update is taken not to
// work, and the launcher goes back to the binary before. So a restart is a whole new process,
// and nothing of the old one (a capture reader, an open spool segment) outlives it.

// RestartCode is the exit code a child uses to have the launcher start the binary to run now.
const RestartCode = 75

// ChildEnv marks the agent process a launcher started; BaseVersionEnv carries the installed
// binary's version, which a child goes back to when the state names nothing before it.
const (
	ChildEnv       = "SILO_AGENT_LAUNCHED"
	BaseVersionEnv = "SILO_AGENT_BASE_VERSION"
)

// FailWindow is how soon a failure after starting an update undoes it.
const FailWindow = 2 * time.Minute

// RunChild runs path with args as the agent, until it exits; its exit code. When ctx ends the
// child is asked to stop (killed if it has not after 30 seconds). Its stdin is a pipe the
// launcher holds: when the launcher goes, however it goes, the child sees it close and stops.
func RunChild(ctx context.Context, path string, args []string, baseVersion string) (int, error) {
	cmd := exec.Command(path, args...)
	cmd.Env = append(os.Environ(), ChildEnv+"=1", BaseVersionEnv+"="+baseVersion)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return 0, err
	}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	defer stdin.Close()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err = <-done:
	case <-ctx.Done():
		if cmd.Process.Signal(os.Interrupt) != nil {
			_ = cmd.Process.Kill()
		}
		select {
		case err = <-done:
		case <-time.After(30 * time.Second):
			_ = cmd.Process.Kill()
			err = <-done
		}
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), nil
	}
	if err != nil {
		return 0, err
	}
	return 0, nil
}

// WatchLauncher stops a child when its launcher has gone: stdin, the launcher's pipe, closes.
func WatchLauncher(stop func()) {
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		stop()
	}()
}
