'use client';

// How much of the person's model allowance they have used: this period's tokens and today's
// limit, set by their organisation (spec 74). Figures only: nothing of any question.

import { useLayoutEffect, useRef } from 'react';
import { Page, Panel, Section } from '../../components/page.component.tsx';
import { QueryView } from '../../components/query.component.tsx';
import { Time } from '../../components/time.component.tsx';
import { useQuery } from '../../data/query.data.ts';
import { usePageContext } from '../../shell/context.shell.tsx';
import { formatNumber } from '../../utils/format.util.ts';
import styles from './account.view.module.css';

/** A share of a whole, drawn as a bar: its width set through the CSSOM, never a style attribute. */
export function Meter({ used, of, label }: { used: number; of: number; label: string }) {
  const fill = useRef<HTMLDivElement | null>(null);
  const share = of <= 0 ? 0 : Math.min(1, Math.max(0, used / of));
  useLayoutEffect(() => {
    fill.current?.style.setProperty('transform', `scaleX(${share})`);
  }, [share]);
  return (
    <div className={styles.meter} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={of} aria-valuenow={used}>
      <div ref={fill} className={styles.meterFill} />
    </div>
  );
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div className={styles.figure}>
      <span className={styles.figureValue}>{value}</span>
      <span className={styles.figureLabel}>{label}</span>
    </div>
  );
}

export function Allowance() {
  const allowance = useQuery('readOwnAllowance', {}, { refreshMs: 60_000 });
  usePageContext({});
  return (
    <Page title="Allowance" description="Ask, recognition and the AI features use model tokens. Your organisation sets how many you may use." width="narrow">
      <QueryView query={allowance} what="Your allowance">
        {(a) => (
          <>
            <p>This period runs from <Time value={a.period.start} exact /> to <Time value={a.period.end} exact />.</p>
            {a.tokens === null ? (
              <Section title="Model tokens"><Panel><p>No token allowance is set for you: the organisation's own limits apply.</p></Panel></Section>
            ) : (
              <>
                <Section title="Today">
                  <Panel>
                    <Meter used={a.tokens.dailyConsumed} of={a.tokens.dailyLimit} label="Today's tokens used" />
                    <div className={styles.figures}>
                      <Figure value={formatNumber(a.tokens.dailyRemaining)} label="left today" />
                      <Figure value={formatNumber(a.tokens.dailyConsumed)} label="used today" />
                      <Figure value={formatNumber(a.tokens.dailyLimit)} label="daily limit" />
                    </div>
                  </Panel>
                </Section>
                <Section title="This period">
                  <Panel>
                    <Meter used={a.tokens.consumed} of={a.tokens.granted} label="This period's tokens used" />
                    <div className={styles.figures}>
                      <Figure value={formatNumber(a.tokens.remaining)} label="left this period" />
                      <Figure value={formatNumber(a.tokens.consumed)} label="used" />
                      <Figure value={formatNumber(a.tokens.granted)} label="granted" />
                    </div>
                  </Panel>
                </Section>
              </>
            )}
          </>
        )}
      </QueryView>
    </Page>
  );
}
