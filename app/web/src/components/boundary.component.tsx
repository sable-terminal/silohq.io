'use client';

// A region that fails on its own: a fault while rendering one panel or page shows a failure in
// its place, with a way to try again, while the rest of the workspace carries on. Reset when
// its key changes (the page navigated), so a fault on one page never follows the person.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from './states.component.tsx';

interface Props {
  children: ReactNode;
  /** What failed, in the failure's title: "This page", "The Ask panel". */
  what?: string;
  /** Changes reset the boundary. */
  resetKey?: string;
}

interface State { failed: boolean; error: unknown; key: string | undefined }

export class Boundary extends Component<Props, State> {
  override state: State = { failed: false, error: undefined, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }

  static getDerivedStateFromProps(props: Props, state: State) {
    return props.resetKey !== state.key ? { failed: false, error: undefined, key: props.resetKey } : null;
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The browser console is the only place a client fault is kept: it never carries record values to a server.
    console.error('[silo] a region failed', error, info.componentStack);
  }

  override render() {
    if (this.state.failed) {
      return <ErrorState error={this.state.error} what={this.props.what} onRetry={() => this.setState({ failed: false, error: undefined })} />;
    }
    return this.props.children;
  }
}
