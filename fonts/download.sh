#!/usr/bin/env bash
# Download curated subtitle fonts from the google/fonts GitHub repo (OFL/Apache licensed).
# Runs idempotently — skips files that already exist.
set -euo pipefail

cd "$(dirname "$0")"

GH="https://raw.githubusercontent.com/google/fonts/main"

# Each entry: "<local-name>|<url-on-github>"
# Variable fonts (wght axis) are used where the static-black file no longer exists in the repo.
declare -a FONTS=(
  "Inter-VF.ttf|${GH}/ofl/inter/Inter%5Bopsz,wght%5D.ttf"
  "Montserrat-VF.ttf|${GH}/ofl/montserrat/Montserrat%5Bwght%5D.ttf"
  "BebasNeue-Regular.ttf|${GH}/ofl/bebasneue/BebasNeue-Regular.ttf"
  "Anton-Regular.ttf|${GH}/ofl/anton/Anton-Regular.ttf"
  "Poppins-Black.ttf|${GH}/ofl/poppins/Poppins-Black.ttf"
  "Oswald-VF.ttf|${GH}/ofl/oswald/Oswald%5Bwght%5D.ttf"
  "Roboto-VF.ttf|${GH}/ofl/roboto/Roboto%5Bwdth,wght%5D.ttf"
  "ArchivoBlack-Regular.ttf|${GH}/ofl/archivoblack/ArchivoBlack-Regular.ttf"
  "PermanentMarker-Regular.ttf|${GH}/apache/permanentmarker/PermanentMarker-Regular.ttf"
  "Bangers-Regular.ttf|${GH}/ofl/bangers/Bangers-Regular.ttf"
)

ok=0
fail=0
for entry in "${FONTS[@]}"; do
  name="${entry%%|*}"
  url="${entry##*|}"
  if [[ -f "$name" ]] && [[ $(wc -c < "$name") -gt 1000 ]]; then
    echo "  already have $name"
    ((ok++))
    continue
  fi
  echo "  downloading $name"
  if curl -fsSL -o "$name" "$url"; then
    ((ok++))
  else
    echo "    FAILED: $url"
    rm -f "$name"
    ((fail++))
  fi
done

echo
echo "done. $ok ok, $fail failed."
echo "Fonts in: $(pwd)"
