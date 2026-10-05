# Lunos GitHub Action

Runs Lunos on GitHub issues and pull requests. Comment `/lunos` or `/oc` and a workflow runs `lunos github run` on the repository, answers in the thread, and opens or updates a pull request when it changes code.

It uses a GitHub token you control: the workflow's `GITHUB_TOKEN`, or a fine-grained personal access token. There is no GitHub App to install and no token-exchange service.

Set it up from the repository with:

```bash
lunos github install
```

Setup, the token's permissions and every input are described at https://docs.lunos.tech/docs/github/.

`action.yml` is the action. `index.ts` is upstream's older standalone action script; this action doesn't run it.
