# Six Degrees: Wikipedia Game Cheat (Web)

Finds the shortest chain of links between any two Wikipedia articles, right in your browser.

**Try it:** https://bruss106.github.io/wikipedia-game-cheat-web/

In the [Wikipedia Game](https://en.wikipedia.org/wiki/Wikipedia:Wiki_Game) you start on one article and try to reach a target article by clicking only links inside the pages you land on. Fewest clicks wins. This app treats Wikipedia as a graph and searches it for you.

This is the JavaScript version of [wikipedia-game-cheat](https://github.com/BRuss106/wikipedia-game-cheat). It needs no server, so it can be hosted for free on GitHub Pages.

## Features

- **Runs entirely in the browser.** It calls the public Wikipedia API directly, so there's no backend, no API key and nothing to install.
- **Bidirectional breadth-first search.** One search grows forward from the start article (following links) and another grows backward from the target ("what links here"). When they meet, the two halves are joined into a shortest path.
- **Only real, clickable links.** Links that appear only in references, "See also", navboxes or citation templates are filtered out, so every step in the answer is a link you can click in the article body.
- **Live search map.** The forward search (cyan) and backward search (amber) grow on a canvas until they meet.
- **Autocomplete** for article titles as you type.
- **Shareable results.** Searches go into the URL, for example `?from=Toaster&to=Mount Kilimanjaro`, and opening that link runs the search.
- **Stop button.** It cancels every request still in flight.

## Run it locally

Browsers don't load JavaScript modules from `file://`, so serve the folder with any static server:

```
python -m http.server 8000
```

Then open <http://localhost:8000>. Add `?demo=1` to the URL to watch the animation with simulated data and no API calls.

## Host it on GitHub Pages

In the repo, go to **Settings → Pages**, choose **Deploy from a branch**, then pick `main` and `/ (root)`. The site goes live at `https://<user>.github.io/<repo>/`.

## How it works

1. **Resolve titles.** Each title is checked against the API, and redirects are followed (for example, "USA" becomes "United States").
2. **Search from both ends.** Each round expands whichever frontier is smaller, one full level at a time, until an article is reached by both searches. Up to 50 titles go in each request.
3. **Verify the path.** The backward search only knows that a page links to another one *somewhere*, so every candidate path is checked against the article body. Links that turn out to be reference-only are banned, and the search runs again (fast, because results are cached for the life of the tab).
4. **Show the shortest path** that survives, with official article titles.

### Being polite to Wikipedia

- Requests identify the app with the `Api-User-Agent` header, because browsers can't set `User-Agent`.
- At most 3 requests are in flight at once, started a short gap apart.
- If Wikipedia answers `429 Too Many Requests`, **all** requests pause for the time it asks, and the pace slows down. It speeds back up gradually.

Every visitor's browser sends its own requests, so the load is spread across users rather than coming from one server.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The page: inputs, animated search map and results |
| `wiki.js` | The search engine: API calls, link extraction and bidirectional BFS |

## Limitations

- Searches that end at a very famous article (for example "United States") can take minutes. These have huge "what links here" lists, and Wikipedia throttles anonymous requests.
- It only works on English Wikipedia.
