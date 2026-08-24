# docs

Drop a screenshot of the running app here as `screenshot.png`, then add this line
to the top of the root README, just under the intro:

```markdown
![The app running a real model](docs/screenshot.png)
```

A good one shows the sidebar with the model cards and fit verdicts, a reply
containing a table and a code block, and the reasoning panel — that is the whole
product in one frame. Use a scratch chats folder so no real conversation titles
appear:

```bash
LANDSLIDE_CHATS_DIR=/tmp/shot npm start
```
