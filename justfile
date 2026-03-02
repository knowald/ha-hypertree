dev:
    npm run dev

build:
    npm run build

preview:
    npm run preview

# Generate a local HTTPS certificate using mkcert
cert:
    mkdir -p .certs
    mkcert -key-file .certs/key.pem -cert-file .certs/cert.pem localhost

# Start dev server with HTTPS (run `just cert` first)
dev-https:
    just cert
    npm run dev
