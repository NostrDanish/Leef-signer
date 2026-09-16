import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { StepHeader, StepFooter } from './common';
import { TEMPLATES } from '@/lib/signer/templates';
import { leefTraderManifest } from '@/lib/signer/templates';
import type { WizardState } from '@/lib/signer/useWizard';

export function StepTemplate({ wizard }: { wizard: WizardState }) {
  const { manifest, chooseTemplate, setStep, setManifest } = wizard;

  return (
    <div className="space-y-6">
      <StepHeader
        title="What are you protecting?"
        sub="The LEEF Trader AI preset is preloaded. Pick a different starting point below if you're deploying for another application."
      />

      <Card className="border-primary/50 bg-primary/5">
        <CardContent className="py-4 flex items-center justify-between gap-4">
          <div className="text-sm">
            <span className="font-medium">LEEF Trader AI (recommended)</span>{' '}
            <span className="text-muted-foreground">
              PayPerQ OpenAI-compatible gateway, server-side analysis prompt, ZDR routing, 8s timeout,
              locked to the LEEF Trader origins. The AI is an analyst — it can never sign or trade.
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              setManifest(leefTraderManifest(manifest.workerName));
              setStep('providers');
            }}
            className="shrink-0 rounded-md bg-primary text-primary-foreground h-9 px-3 text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            Load LEEF Trader preset
          </button>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => chooseTemplate(t.id)}
            className={cn(
              'text-left rounded-xl border p-4 transition-all hover:border-primary/60 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              manifest.template === t.id ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'border-border bg-card',
            )}
          >
            <div className="flex items-center gap-3">
              <span className="text-2xl" aria-hidden>
                {t.emoji}
              </span>
              <div>
                <div className="font-semibold">{t.label}</div>
                <div className="text-sm text-muted-foreground leading-snug mt-0.5">{t.blurb}</div>
              </div>
            </div>
          </button>
        ))}
      </div>

      <StepFooter onBack={() => setStep('cloudflare')} onNext={() => setStep('providers')} />
    </div>
  );
}
