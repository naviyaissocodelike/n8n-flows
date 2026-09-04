# Self-Hosted Runner Setup (Hetzner)

This repo uses a self-hosted GitHub Actions runner on Hetzner for deployment.

## Why Option 2 (self-hosted runner)

- No SSH exposed to the internet
- Runner authenticates to GitHub (not the other way around)
- Local interaction via `docker exec`
- Aligns with existing Docker knowledge

## Prerequisites

- Docker and Docker Compose installed on your Hetzner server

## Quickstart

```bash
mkdir -p ~/actions-runner && cd ~/actions-runner

# Run the GitHub Actions runner (replace YOUR_TOKEN with the registration token)
docker run -d --restart always \
  --name github-actions-runner \
  -e REPO_URL="https://github.com/naviyaissocodelike/n8n-flows" \
  -e RUNNER_NAME="hetzner-n8n-runner" \
  -e RUNNER_TOKEN="YOUR_TOKEN" \
  -e LABELS="self-hosted,n8n,hetzner" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd):/runner/_work \
  myoung34/github-runner:latest
```

### Get a registration token

1. Go to **Settings** → **Actions** → **Runners** in this repo
2. Click **New self-hosted runner**
3. Copy the token from the setup instructions

### Verify

```bash
docker logs -f github-actions-runner
```

## Restart / Remove

```bash
# Restart
docker restart github-actions-runner

# Remove
docker rm -f github-actions-runner
```

## Labels

The `deploy.yml` workflow targets `self-hosted`. Add `n8n` and `hetzner` labels to
the runner if you want to use them in other workflows.