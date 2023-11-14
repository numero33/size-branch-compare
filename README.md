# Download workflow artifact GitHub Action

Compare size changes of your bundle on Pull Requests.

## Usage

```yaml
name: SizeCompare CI

on:
  push:
    branches:
      - main
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]
  workflow_dispatch:

jobs:
  size-compare:
    runs-on: ubuntu-latest
    steps:
      - name: 🛎️ Checkout
        uses: actions/checkout@v3

      # Add here your setup, installation, and build steps

      - name: 🚛 Size compare
        uses: numero33/size-branch-compare
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          files: |
            dist/**.js
            !dist/**.js.map
```