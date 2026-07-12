export const LISTING_CARDS_URI = "ui://propai/listing-cards";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

export const listingCardsHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: transparent;
    padding: 8px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 10px;
  }
  .card {
    border: 1px solid rgba(127, 127, 127, 0.22);
    border-radius: 8px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: rgba(127, 127, 127, 0.06);
  }
  .title {
    font-size: 0.9rem;
    font-weight: 700;
    line-height: 1.3;
  }
  .price {
    font-size: 1.08rem;
    font-weight: 750;
  }
  .meta, .broker, .source {
    font-size: 0.82rem;
    opacity: 0.76;
    line-height: 1.35;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    border: 1px solid rgba(127, 127, 127, 0.18);
    border-radius: 999px;
    padding: 3px 7px;
    font-size: 0.74rem;
    opacity: 0.9;
  }
  button {
    margin-top: 4px;
    padding: 8px 10px;
    border-radius: 7px;
    border: 0;
    background: #10b981;
    color: #04110d;
    font-weight: 700;
    cursor: pointer;
  }
  button:hover { filter: brightness(1.05); }
  .empty {
    grid-column: 1 / -1;
    padding: 22px;
    text-align: center;
    opacity: 0.65;
  }
</style>
</head>
<body>
  <div id="root" class="grid"></div>
  <script type="module">
    import { App } from "https://esm.sh/@modelcontextprotocol/ext-apps";

    const app = new App();

    app.onToolResult((result) => {
      render(result?._meta?.listings || result?.structuredContent?.listing_cards || []);
    });

    function render(listings) {
      const root = document.getElementById("root");
      root.innerHTML = "";

      if (!Array.isArray(listings) || listings.length === 0) {
        root.innerHTML = '<div class="empty">No listings found. Try widening the locality, budget, or BHK.</div>';
        return;
      }

      for (const listing of listings) {
        const card = document.createElement("div");
        card.className = "card";
        const title = listing.title || listing.locality || "Property";
        const locality = listing.locality || listing.location || "Locality not shared";
        const price = listing.price_display || "Price on request";
        const broker = listing.broker_name || "Broker";
        const source = listing.source_group_name ? "From " + listing.source_group_name : "";
        card.innerHTML = [
          '<div class="title">' + escapeHtml(title) + '</div>',
          '<div class="price">' + escapeHtml(price) + '</div>',
          '<div class="chips">',
          chip(listing.bhk ? listing.bhk + " BHK" : null),
          chip(listing.property_type),
          chip(listing.area_display),
          '</div>',
          '<div class="meta">' + escapeHtml(locality) + '</div>',
          '<div class="broker">' + escapeHtml(broker) + '</div>',
          source ? '<div class="source">' + escapeHtml(source) + '</div>' : '',
        ].join("");

        const button = document.createElement("button");
        button.textContent = "Contact broker";
        button.onclick = () => {
          app.callTool("contact_call", {
            listing_id: listing.source_message_id || listing.id,
            name: listing.broker_name,
            phone: listing.broker_phone,
          });
        };
        card.appendChild(button);
        root.appendChild(card);
      }
    }

    function chip(value) {
      return value ? '<span class="chip">' + escapeHtml(String(value)) + '</span>' : '';
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      }[char]));
    }

    app.connect();
  </script>
</body>
</html>`;
