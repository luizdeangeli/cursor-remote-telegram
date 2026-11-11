.DEFAULT_GOAL := ajuda

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
UNIT := cursor-telegram.service
ENV_FILE := $(ROOT)/.env

.PHONY: ajuda status config iniciar parar reiniciar logs seguir teste probe diagnostico cursor porta instalar compartilhar intervalo linger env-chave

ajuda:
	@printf '%s\n' \
		'make status                 serviço, porta 9222 e o modo de compartilhar' \
		'make config                 variáveis do .env, sem o token' \
		'make iniciar                sobe o serviço' \
		'make parar                  para o serviço' \
		'make reiniciar              aplica o .env de novo' \
		'make logs                   últimas linhas do serviço' \
		'make seguir                 acompanha o log' \
		'make teste                  testes, sem Cursor e sem Telegram' \
		'make probe                  o que a porta 9222 está expondo' \
		'make diagnostico            causa da falha, sem o token' \
		'make porta                  a porta 9222 está aberta?' \
		'make cursor                 abre o Cursor nessa porta' \
		'make instalar               instala e liga o serviço de usuário' \
		'make compartilhar              inverte todas/escolhidas, grava e reinicia' \
		'make compartilhar MODO=todas   força o modo e reinicia' \
		'make intervalo MS=2000      grava POLL_INTERVAL_MS e reinicia' \
		'make linger                 sobe o serviço de usuário no boot (pede senha)'

status:
	@systemctl --user --no-pager --lines=12 status $(UNIT) || true
	@echo
	@if ss -ltn | grep -q '127.0.0.1:9222'; then echo 'Porta 9222: aberta'; else echo 'Porta 9222: fechada. Rode: make cursor'; fi
	@$(MAKE) --no-print-directory config

config:
	@test -f $(ENV_FILE) || { echo 'Falta $(ENV_FILE). Copie .env.example para .env.'; exit 1; }
	@awk -F= ' \
		$$1=="TELEGRAM_BOT_TOKEN" { print "TELEGRAM_BOT_TOKEN=" ($$2=="" ? "ausente" : "definido"); next } \
		$$1=="TELEGRAM_ALLOWED_USER_ID" || $$1=="TELEGRAM_CHAT_ID" || $$1=="CDP_URL" || $$1=="POLL_INTERVAL_MS" || $$1=="COMPARTILHAR" { print } \
	' $(ENV_FILE)

iniciar:
	systemctl --user start $(UNIT)
	@systemctl --user --no-pager --lines=8 status $(UNIT)

parar:
	systemctl --user stop $(UNIT)

reiniciar:
	@systemctl --user show -p LoadState --value $(UNIT) | grep -qx loaded || { echo 'Serviço não instalado. Rode: make instalar'; exit 1; }
	systemctl --user restart $(UNIT)
	@systemctl --user is-active $(UNIT)

logs:
	journalctl --user -u $(UNIT) -n 80 --no-pager

seguir:
	journalctl --user -u $(UNIT) -f

teste:
	cd $(ROOT) && node --test

probe:
	cd $(ROOT) && node bin/probe.mjs

diagnostico:
	cd $(ROOT) && node bin/diagnostico.mjs

porta:
	@if ss -ltn | grep -q '127.0.0.1:9222'; then echo 'Porta 9222 aberta.'; else echo 'Porta 9222 fechada. Feche o Cursor pelo Quit e rode: make cursor'; exit 1; fi

cursor:
	$(ROOT)/bin/cursor-debug

instalar:
	@command -v node >/dev/null || { echo 'Node não está no PATH.'; exit 1; }
	mkdir -p $(HOME)/.config/systemd/user
	sed -e 's|@ROOT@|$(ROOT)|g' -e 's|/usr/bin/node|$(shell command -v node)|g' \
		$(ROOT)/systemd/cursor-telegram.service \
		> $(HOME)/.config/systemd/user/$(UNIT)
	systemctl --user daemon-reload
	systemctl --user enable --now $(UNIT)
	@systemctl --user --no-pager --lines=12 status $(UNIT)

compartilhar:
	@test -f $(ENV_FILE) || { echo 'Falta $(ENV_FILE). Copie .env.example para .env.'; exit 1; }; \
	modo='$(MODO)'; \
	atual=$$(sed -n 's/^COMPARTILHAR=//p' '$(ENV_FILE)' | head -n 1); \
	if [ -z "$$modo" ]; then \
		if [ "$$atual" = escolhidas ]; then modo=todas; else modo=escolhidas; fi; \
		echo "Invertido: $${atual:-ausente} -> $$modo"; \
	elif [ "$$modo" != todas ] && [ "$$modo" != escolhidas ]; then \
		echo 'MODO precisa ser todas ou escolhidas.'; exit 1; \
	fi; \
	$(MAKE) --no-print-directory env-chave CHAVE=COMPARTILHAR VALOR="$$modo"; \
	if [ "$$modo" = todas ]; then \
		echo 'Modo todas cria um tópico para cada conversa visível.'; \
	else \
		echo 'Modo escolhidas só cria depois de Incluir, em Projetos. /recarregar apaga os tópicos e a seleção.'; \
	fi; \
	$(MAKE) --no-print-directory reiniciar

intervalo:
	@test -n '$(MS)' || { echo 'Use: make intervalo MS=2000'; exit 1; }
	@echo '$(MS)' | grep -Eq '^[0-9]+$$' || { echo 'MS precisa ser um inteiro entre 500 e 120000.'; exit 1; }
	@test $(MS) -ge 500 -a $(MS) -le 120000 || { echo 'MS precisa ser um inteiro entre 500 e 120000.'; exit 1; }
	@$(MAKE) --no-print-directory env-chave CHAVE=POLL_INTERVAL_MS VALOR='$(MS)'
	@$(MAKE) --no-print-directory reiniciar

linger:
	sudo loginctl enable-linger "$(USER)"

env-chave:
	@test '$(CHAVE)' = 'COMPARTILHAR' -o '$(CHAVE)' = 'POLL_INTERVAL_MS' || { echo 'Este atalho só altera COMPARTILHAR e POLL_INTERVAL_MS.'; exit 1; }
	@test -n '$(VALOR)'
	@test -f $(ENV_FILE) || { echo 'Falta $(ENV_FILE). Copie .env.example para .env.'; exit 1; }
	@if grep -q '^$(CHAVE)=' $(ENV_FILE); then \
		sed -i 's|^$(CHAVE)=.*|$(CHAVE)=$(VALOR)|' $(ENV_FILE); \
	else \
		printf '\n%s=%s\n' '$(CHAVE)' '$(VALOR)' >> $(ENV_FILE); \
	fi
	@chmod 600 $(ENV_FILE)
	@echo '$(CHAVE)=$(VALOR)'
