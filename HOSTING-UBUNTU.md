# StockNews on Ubuntu

## Quick local run

Requirements: Node.js 20 or newer and a Finnhub API key.

```bash
git clone https://github.com/cyberther/StockNews.git
cd StockNews
cp .env.example .env
nano .env
npm test
npm run build
npm start
```

Keep `HOST=127.0.0.1` for access only from this PC. Open `http://127.0.0.1:8080`.

For access from the local network, change it to `HOST=0.0.0.0`, restart the process and open
`http://<PC-IP>:8080` from another device. If UFW is enabled, permit only the local subnet, for
example `sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp`.

## Run permanently with systemd

The included unit expects the application in `/opt/stocknews` and runs it under a dedicated,
unprivileged account.

```bash
sudo useradd --system --home /opt/stocknews --shell /usr/sbin/nologin stocknews
sudo mkdir -p /opt/stocknews
sudo cp -a . /opt/stocknews/
sudo chown -R root:stocknews /opt/stocknews
sudo chmod 640 /opt/stocknews/.env
sudo cp deploy/stocknews.service /etc/systemd/system/stocknews.service
sudo systemctl daemon-reload
sudo systemctl enable --now stocknews
sudo systemctl status stocknews
```

After updating the repository, rebuild it and restart the service:

```bash
npm test
npm run build
sudo rsync -a --delete --exclude=.env --exclude=.git ./ /opt/stocknews/
sudo chown -R root:stocknews /opt/stocknews
sudo chmod 640 /opt/stocknews/.env
sudo systemctl restart stocknews
```

## Preparing for public access

Do not expose port 8080 directly. Put Caddy or Nginx in front of `127.0.0.1:8080`, use a domain,
TLS and an application authentication layer. The current origin check and IP rate limit reduce
casual API abuse, but they are not user authentication.

Before public launch, replace the prototype Free/Pro controls with real server-side accounts and
entitlements. Confirm that the market-data providers permit the intended public display and usage.
