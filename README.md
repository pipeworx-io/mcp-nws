# @pipeworx/nws

US National Weather Service MCP — authoritative US forecasts + alerts. No auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

- `get_forecast(latitude, longitude)` — 7-day text forecast for a US lat/lon.
- `get_hourly_forecast(latitude, longitude, max_hours?)` — hourly forecast.
- `get_alerts(area?, latitude?, longitude?, severity?, urgency?, event?, limit?)` — active watches/warnings/advisories.
- `get_observation(station_id)` — latest observation from an ICAO station.

## Data source

`https://api.weather.gov` — public, no key. NWS requests a unique `User-Agent` header on every request; this pack sends `Pipeworx-NWS-MCP/0.1 (contact@mojibake.ai)`.

US locations only.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "nws": {
      "url": "https://gateway.pipeworx.io/nws/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Nws data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
