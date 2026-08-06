# Why AGPL-3.0?

Short version: **Quintal is free software, forever, for everyone who runs it.**
The AGPL exists to keep it that way.

## What the AGPL actually requires

The AGPL is the GPL plus one extra clause: if you modify Quintal and let other
people use it **over a network**, you have to offer those users your modified
source. That's it. It's aimed squarely at the "take an open-source project,
change it, run it as a closed SaaS, contribute nothing back" pattern — which for
a product that is inherently a hosted, multi-user service is the only realistic
way for it to be taken proprietary.

## What this means if you self-host

If you are running Quintal for yourself, your team, or your company:

- **You can run it, free, forever.** No user limits, no feature gates, no
  license key, no telemetry ping to us. There is no "open core" here — the whole
  product is in this repo.
- **You can modify it.** Change anything. Rip out what you don't want.
- **You do not have to publish your changes** just because you deployed it
  internally — the source offer runs to the *users of the service*, which for an
  internal deployment is your own colleagues. In practice: if you host Quintal
  for your own organisation, hand your team the modified source if they ask, and
  you're done.
- **Your own data, prompts, agent code and configuration are yours.** The AGPL
  covers Quintal's source code, not what you do with it or what flows through
  it. Running your proprietary agents against Quintal does not make them AGPL.

The case the license actually bites is: you fork Quintal, make it better, and
sell it as a hosted service to the public — then those users are entitled to
your improvements. That seems fair.

## Why not MIT?

MIT is a great license and this question will come up in the issue tracker, so
here's the reasoning rather than a shrug:

1. **Quintal is a service, not a library.** For libraries, permissive licensing
   maximises adoption and everyone wins. For a hosted product, permissive
   licensing mostly means a well-funded company can run your work at scale, add
   the polish, and out-market you with your own code. AGPL removes that as an
   option without taking anything away from users who self-host.
2. **It protects contributors, not just the maintainers.** If you send a patch,
   the AGPL is the promise that it can't be quietly absorbed into a closed
   product.
3. **Reciprocity beats charity.** Anyone who improves Quintal in a public
   service has to share those improvements, which makes the project better for
   the people running it themselves.

## Things AGPL does *not* do

- It doesn't stop commercial use. Companies can use Quintal at work, for profit,
  without paying or publishing anything.
- It doesn't infect your other software. Talking to Quintal over a network —
  which is how agents connect — is not linking. Your agents keep whatever
  license you like.
- It doesn't require a CLA. We use [DCO sign-off](./CONTRIBUTING.md) instead, so
  you keep your copyright and no one can unilaterally relicense the project.

## If the AGPL genuinely blocks you

Open an issue and describe the situation. There may be a straightforward answer,
and if there isn't, it's worth knowing about.

*This is a plain-English summary written by the project, not legal advice. The
[LICENSE](./LICENSE) file is what's binding.*
