import React, { useCallback, useEffect, useState } from 'react';
import type { CrewWindowsProgress, CrewWindowsRepairResult, CrewWindowsSetupResult, CrewWindowsState } from '../../../../shared/types';
import '../Crew.css';

export interface WindowsSetupProps {
  checkState?: () => Promise<CrewWindowsState | null>;
  setup?: () => Promise<CrewWindowsSetupResult>;
  repair?: (confirmed: boolean) => Promise<CrewWindowsRepairResult>;
  onProgress?: (cb: (p: CrewWindowsProgress) => void) => () => void;
}

const STEP_TEXT: Record<string, string> = {
  wsl: 'Checking WSL2',
  link: 'Linking this PC to Crew',
  download: "Downloading Crew's Linux image",
  import: "Installing Crew's Linux image",
  user: "Creating Crew's user",
  'wsl-conf': 'Configuring WSL',
  shipped: "Installing Crew's tools",
  apt: 'Installing system packages',
  interop: 'Checking Windows interop',
};

const READY = "Crew's Windows setup is ready.";

/** Crew → Windows setup: where it stands, Set up Crew on Windows, and Repair. Shows nothing off Windows. */
export const WindowsSetup: React.FC<WindowsSetupProps> = ({ checkState, setup, repair, onProgress }) => {
  const api = () => window.electronAPI;
  const doCheck = checkState ?? (() => api().crewWindowsCheckState());
  const doSetup = setup ?? (() => api().crewWindowsSetup());
  const doRepair = repair ?? ((c: boolean) => api().crewWindowsRepair(c));
  const listen = onProgress ?? ((cb: (p: CrewWindowsProgress) => void) => api()?.onCrewWindowsSetupProgress?.(cb) ?? (() => {}));

  const [state, setState] = useState<CrewWindowsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<CrewWindowsProgress | null>(null);
  const [result, setResult] = useState<CrewWindowsSetupResult | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);

  const refresh = useCallback(() => {
    doCheck().then(setState, () => setState(null));
  }, [doCheck]);
  useEffect(refresh, []);
  useEffect(() => listen(setStep), []);

  const finished = (r: CrewWindowsSetupResult) => {
    setResult(r);
    setStep(null);
    if (r.ok) setState({ state: 'ready' });
  };
  const runSetup = async () => {
    setBusy(true);
    setResult(null);
    try {
      finished(await doSetup());
    } finally {
      setBusy(false);
    }
  };
  const runRepair = async (confirmed: boolean) => {
    setPrompt(null);
    setBusy(true);
    setResult(null);
    try {
      const r = await doRepair(confirmed);
      if ('confirm' in r) setPrompt(r.confirm);
      else finished(r);
    } finally {
      setBusy(false);
    }
  };

  if (!state) return null;
  const failed = result && !result.ok ? result : null;
  const canRepair = state.state === 'wsl1' || state.state === 'needs-repair' || (failed?.repair ?? false);
  return (
    <section className="crew-windows-setup" aria-label="Windows setup">
      {state.state === 'ready' ? <p>{READY}</p> : <p>{state.message}</p>}
      {state.state === 'no-wsl' && (
        <>
          <p>Open PowerShell as administrator, run <code>wsl --install</code>, restart the PC, then check again.</p>
          <button type="button" onClick={refresh} disabled={busy}>Check again</button>
        </>
      )}
      {state.state === 'missing' && (
        <button type="button" onClick={runSetup} disabled={busy}>Set up Crew on Windows</button>
      )}
      {canRepair && !prompt && (
        <button type="button" onClick={() => runRepair(false)} disabled={busy}>Repair</button>
      )}
      {prompt && (
        <div role="alertdialog" aria-label="Repair">
          <p>{prompt}</p>
          <button type="button" onClick={() => runRepair(true)}>Continue</button>
          <button type="button" onClick={() => setPrompt(null)}>Cancel</button>
        </div>
      )}
      {busy && step && <p role="status">{step.message ?? STEP_TEXT[step.step] ?? step.step}</p>}
      {failed && <p role="alert">{failed.message}</p>}
      {result?.ok && result.message && <p role="status">{result.message}</p>}
    </section>
  );
};
