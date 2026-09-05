# Optional: run deploys from the Hetzner box

By default the deploy and plan jobs run on GitHub's runners and reach
`n8n.districtangels.com` over the public internet. That works, and you can skip this
page entirely.

Registering a self-hosted runner on the Hetzner server instead means deploys originate
from inside your own network. The useful consequence is that the n8n API no longer has
to accept requests from GitHub's IP ranges, so you can firewall it down to the box
itself once everything is working.

The runner connects out to GitHub and polls for jobs, so nothing new is exposed
inbound. No SSH access for GitHub, no inbound port.

## Set it up

On the Hetzner server, with Docker already installed:

```bash
mkdir -p ~/actions-runner && cd ~/actions-runner

docker run -d --restart always \
  --name github-actions-runner \
  -e REPO_URL="https://github.com/naviyaissocodelike/n8n-flows" \
  -e RUNNER_NAME="hetzner-n8n-runner" \
  -e RUNNER_TOKEN="YOUR_TOKEN" \
  -e LABELS="self-hosted,n8n,hetzner" \
  -v $(pwd):/runner/_work \
  myoung34/github-runner:latest
```

Get `YOUR_TOKEN` from the repo: **Settings → Actions → Runners → New self-hosted
runner**. It expires in an hour, so grab it right before you run the command.

Check it registered:

```bash
docker logs -f github-actions-runner
```

The runner should appear as idle under Settings → Actions → Runners.

## Point the workflows at it

Add a repository **variable** (not a secret): **Settings → Secrets and variables →
Actions → Variables → New**, named `N8N_RUNNER` with the value `self-hosted`.

Deploy and plan pick it up on the next run. Validation and import stay on GitHub's
runners, since neither touches the instance and you do not want them queuing behind a
box that might be down.

To go back, delete the variable.

## Node

The workflows use `actions/setup-node@v4`, which downloads Node into the runner's work
directory. That works in the container above without anything extra.

## If jobs start queuing forever

A job stuck on "Waiting for a runner" means the `N8N_RUNNER` variable is set but no
runner with that label is online. Either start the container again or delete the
variable to fall back to GitHub's runners.

## A note on the Docker socket

You will see setups that mount `/var/run/docker.sock` into the runner. Do not do that
here. It gives any job full control of the host's Docker, including the n8n container
itself, and nothing in these workflows needs it.
