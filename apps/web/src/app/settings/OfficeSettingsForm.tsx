'use client';

import {
  SETTING_LIMITS,
  WORKSPACE_NAME_MAX_LENGTH,
  type OfficeSettings,
} from '@quintal/shared';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { saveSettingsAction, type SettingsState } from './actions';

const INITIAL: SettingsState = { ok: false };

interface FieldProps {
  name: keyof OfficeSettings;
  label: string;
  unit: string;
  help: string;
  value: number;
  min: number;
  max: number;
}

function Field({ name, label, unit, help, value, min, max }: FieldProps) {
  return (
    <div className="flex flex-col gap-1 border-t py-4 first:border-t-0 sm:flex-row sm:items-start sm:gap-6">
      <div className="sm:w-64 sm:shrink-0">
        <label htmlFor={name} className="text-sm font-medium">
          {label}
        </label>
        <p className="text-muted-foreground mt-0.5 text-xs">{help}</p>
      </div>
      <div className="flex items-center gap-2">
        <Input
          id={name}
          name={name}
          type="number"
          defaultValue={value}
          min={min}
          max={max}
          className="w-24"
        />
        <span className="text-muted-foreground text-xs">{unit}</span>
      </div>
    </div>
  );
}

export function OfficeSettingsForm({
  settings,
  workspaceName,
}: {
  settings: OfficeSettings;
  workspaceName: string;
}) {
  const [state, formAction, pending] = useActionState(saveSettingsAction, INITIAL);
  const current = state.saved ?? settings;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <section>
        <h2 className="text-sm font-semibold">This office</h2>
        <p className="text-muted-foreground mt-1 max-w-2xl text-xs">
          Named after you to begin with, because your key was the only name
          anything had. It does not have to stay that way — an office is a
          place, and it can be called whatever the place is.
        </p>

        <div className="mt-3 flex flex-col gap-1 py-4 sm:flex-row sm:items-start sm:gap-6">
          <div className="sm:w-64 sm:shrink-0">
            <label htmlFor="workspaceName" className="text-sm font-medium">
              Office name
            </label>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Shown in the header and to anyone you invite.
            </p>
          </div>
          <Input
            id="workspaceName"
            name="workspaceName"
            defaultValue={workspaceName}
            maxLength={WORKSPACE_NAME_MAX_LENGTH}
            required
            className="sm:max-w-sm"
          />
        </div>
      </section>

      <section className="border-t pt-4">
        <h2 className="text-sm font-semibold">How the office sounds</h2>
        <p className="text-muted-foreground mt-1 max-w-2xl text-xs">
          These take effect within about ten seconds — no restart, nobody gets
          disconnected. They apply to the whole instance: office rooms are keyed
          by map, not by workspace, so everyone signed in shares one office.
        </p>

        <div className="mt-3">
          <Field
            name="chatRadiusTiles"
            label="Earshot"
            unit="tiles"
            help="How far speech carries. Larger makes the office feel like one room; smaller makes it feel like many."
            value={current.chatRadiusTiles}
            min={SETTING_LIMITS.chatRadiusTiles.min}
            max={SETTING_LIMITS.chatRadiusTiles.max}
          />
          <Field
            name="walkUpRadiusTiles"
            label="Walk-up distance"
            unit="tiles"
            help="How close you must stand for an agent to answer without being named. Beyond this, use @name."
            value={current.walkUpRadiusTiles}
            min={SETTING_LIMITS.walkUpRadiusTiles.min}
            max={SETTING_LIMITS.walkUpRadiusTiles.max}
          />
          <Field
            name="replyWindowSeconds"
            label="Reply reach"
            unit="seconds"
            help="After you @mention someone from out of earshot, how long their reply still reaches you. 0 turns it off."
            value={current.replyWindowSeconds}
            min={SETTING_LIMITS.replyWindowSeconds.min}
            max={SETTING_LIMITS.replyWindowSeconds.max}
          />
        </div>
      </section>

      <div className="flex items-center gap-3 border-t pt-4">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
        {state.ok ? (
          <span className="text-xs text-emerald-600">Saved — live within 10s.</span>
        ) : null}
        {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
      </div>
    </form>
  );
}
