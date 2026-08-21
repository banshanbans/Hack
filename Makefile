PYTHON ?= .venv/bin/python
PYTHONPATH_VALUE := services
WEB_DIR := apps/web
IOS_WORKSPACE := apps/ios/RASSAR App.xcworkspace
IOS_DERIVED_DATA ?= /tmp/anjuguard-build
NPM_CACHE ?= /tmp/anjuguard-npm-cache

.PHONY: setup ios-setup dev-api dev-web check test test-backend test-web test-core build-web build-ios docker-build

setup:
	python3 -m venv .venv
	$(PYTHON) -m pip install -r services/backend/requirements.txt
	npm --prefix $(WEB_DIR) ci --cache $(NPM_CACHE)

ios-setup:
	cd apps/ios && pod install

dev-api:
	PYTHONPATH=$(PYTHONPATH_VALUE) $(PYTHON) -m backend.app.server

dev-web:
	npm --prefix $(WEB_DIR) run dev

check:
	python3 scripts/check_repo_structure.py
	python3 scripts/check_product_copy.py

test-backend:
	PYTHONPATH=$(PYTHONPATH_VALUE) $(PYTHON) -m unittest discover -s services/backend/tests -v

test-web:
	npm --prefix $(WEB_DIR) run typecheck
	npm --prefix $(WEB_DIR) test
	npm --prefix $(WEB_DIR) run build

test-core:
	swift test --package-path packages/AnjuCore

test: check test-backend test-web test-core

build-web:
	npm --prefix $(WEB_DIR) run build

build-ios:
	xcodebuild \
		-workspace "$(IOS_WORKSPACE)" \
		-scheme "RetroAccess App" \
		-configuration Debug \
		-destination 'generic/platform=iOS' \
		-derivedDataPath "$(IOS_DERIVED_DATA)" \
		CODE_SIGNING_ALLOWED=NO \
		build

docker-build:
	docker build -f deploy/Dockerfile -t anju-app:repo-layout .
