'use client';

import {
  SETTING_LIMITS,
  OFFICE_NAME_MAX_LENGTH,
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
  instanceName,
  workspaceName,
  canChangeInstance,
  canChangeOffice,
  host,
}: {
  /** How this office's room behaves. The owner's to tune. */
  settings: OfficeSettings;
  /** What the whole deployment calls itself. Only an instance admin's to set. */
  instanceName: string;
  workspaceName: string;
  /**
   * Whether this person may change anything instance-wide.
   *
   * Covers the radii as well as the name. Gating the action but showing the
   * fields is the worse lie of the two: you edit an earshot, press Save, and
   * are told it is live within ten seconds while nothing has changed.
   */
  canChangeInstance: boolean;
  /**
   * Whether this person may tune this office. Everybody but a guest — a guest
   * is here for one visit and the room is not theirs to reshape.
   */
  canChangeOffice: boolean;
  /**
   * The address this office answers on, from the server.
   *
   * Read there rather than from `window`, because a `'use client'` module is
   * still server-rendered — `typeof window === 'undefined' ? '' : …` renders
   * empty on the server and something else on the client, which is a hydration
   * mismatch of exactly the kind already fixed once in this codebase.
   */
  host: string;
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
              Your office
            </label>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Shown in the header and to anyone you invite. Yours — it is not
              what this server is called.
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

        {/*
          Two names, and they are genuinely different things: the one above
          belongs to a person, this one to the deployment. The product calls
          both an "office" — a workspace is displayed as "Josh's Office", and so
          is the thing you pick in the app's switcher — so the labels say which
          is which rather than pretending the collision is not there.
        */}
        {canChangeInstance ? (
          <div className="mt-1 flex flex-col gap-1 border-t py-4 sm:flex-row sm:items-start sm:gap-6">
            <div className="sm:w-64 sm:shrink-0">
              <label htmlFor="officeName" className="text-sm font-medium">
                This server
              </label>
              <p className="text-muted-foreground mt-0.5 text-xs">
                Shown on the sign-in page, before anybody has an account here.
                Leave it empty and the address is shown instead.
              </p>
            </div>
            <Input
              id="officeName"
              name="officeName"
              defaultValue={instanceName}
              maxLength={OFFICE_NAME_MAX_LENGTH}
              placeholder={host}
              className="sm:max-w-sm"
            />
          </div>
        ) : null}
      </section>

      {/*
        No longer behind the instance gate. These used to apply to every office
        on the deployment, because rooms were keyed by map alone and shared one
        settings row; now a room belongs to one office, so tuning it is the
        owner's business. Guests still cannot — the server refuses them, and
        this is hidden rather than shown-and-refused so nobody is invited to try
        and then told it worked.
      */}
      {canChangeOffice ? (
      <section className="border-t pt-4">
        <h2 className="text-sm font-semibold">How this office sounds</h2>
        <p className="text-muted-foreground mt-1 max-w-2xl text-xs">
          These take effect within about ten seconds — no restart, nobody gets
          disconnected. They apply to <strong>this office only</strong>; another
          office on the same deployment keeps its own.
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
      ) : null}

      <div className="flex items-center gap-3 border-t pt-4">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
        {state.ok ? (
          <span className="text-xs text-emerald-600">
            {canChangeOffice ? 'Saved — live within 10s.' : 'Saved.'}
          </span>
        ) : null}
        {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
      </div>
    </form>
  );
}
