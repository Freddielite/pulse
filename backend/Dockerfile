# Optional. Only needed if you're using the "browser" (headless-Chromium)
# check type - see HANDOVER.md "Headless-browser checks" for why this
# exists and when you need it. Every other check type (http, synthetic)
# runs fine on Render's normal Node buildpack with no Dockerfile at all;
# don't switch to this unless you're actually using browser monitors.
#
# Playwright's official image already has every system library Chromium
# needs preinstalled (nss, atk, cups, etc.) - the exact list is long,
# Debian-version-specific, and exactly what breaks a plain
# `npx playwright install chromium` on a generic Node buildpack image with
# a cryptic missing-.so error instead of a clear one. Starting from their
# image sidesteps that entirely instead of hand-maintaining an apt-get
# list here that'll drift out of sync with whatever Chromium version
# playwright-core pulls in next.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# The base image ships Chromium/Firefox/WebKit already downloaded, so no
# separate `playwright install` step is needed here the way it would be on
# a plain node:20 image.

EXPOSE 10000
CMD ["node", "src/index.js"]
