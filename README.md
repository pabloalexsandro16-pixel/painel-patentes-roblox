# Painel de Patentes Roblox (grupo 1029517697)

Painel inicial para registrar treinamentos e solicitar promoção de patente usando Roblox Open Cloud Groups API.

## Antes de começar
- O painel só permite login de contas configuradas pelo responsável.
- Instrutores são contas do painel configuradas em `INSTRUCTORS_JSON`. A autorização é administrativa; não é uma verificação automática do cargo Roblox do instrutor.
- Por segurança, promoções para ranks acima de `MAX_PROMOTION_RANK` ficam bloqueadas. O padrão é 100. Confira os ranks reais no grupo antes de alterar.
- Configure uma chave Open Cloud somente com as permissões necessárias de leitura de membros/cargos e atribuição de cargos para o grupo correto. A chave precisa ter escopo `group:write` e permissões para listar cargos e membros.
- Nunca compartilhe a chave da API, senha de administrador ou `COOKIE_SECRET`.

## Variáveis de ambiente no Render
Configure no serviço Web Service > Environment:

- `ROBLOX_GROUP_ID` = `1029517697`
- `ROBLOX_API_KEY` = chave Open Cloud criada no Creator Dashboard
- `ADMIN_USERNAME` = nome de login administrativo, por exemplo `admin-eb`
- `ADMIN_PASSWORD` = uma senha forte exclusiva para o painel
- `COOKIE_SECRET` = uma string aleatória longa, exclusiva
- `INSTRUCTORS_JSON` = JSON com login e senha para cada instrutor, por exemplo `{"instrutor01":"troque-esta-senha","instrutor02":"outra-senha-forte"}`
- `DATABASE_URL` = URL interna/externa do PostgreSQL criado para este app
- `MAX_PROMOTION_RANK` = `100` (limite de segurança inicial; não aumente sem revisar a hierarquia)

Não use a senha do Roblox como senha do painel. Use senhas exclusivas.

## PostgreSQL
Crie um banco PostgreSQL no Render e copie a `Internal Database URL` para `DATABASE_URL` quando o serviço web estiver na mesma região. O servidor cria a tabela `training_log` automaticamente.

## Deploy no Render
1. Coloque estes arquivos em um repositório GitHub seu.
2. No Render, escolha **New + > Web Service** e conecte o repositório.
3. Runtime: Node. Build Command: `npm install`. Start Command: `npm start`.
4. Adicione as variáveis acima e faça deploy.
5. Abra o endereço `onrender.com` gerado pelo Render e entre com a conta administrativa.
6. Confira a lista de patentes exibida. Faça primeiro testes com um jogador de teste e uma patente de baixo nível.

## Importante sobre a API
O endpoint de atribuição usado é `POST /cloud/v2/groups/{group_id}/memberships/{membership_id}:assignRole` com corpo `{"roleId":"ID_DA_PATENTE"}`. O grupo e a chave precisam autorizar a operação. Se a API rejeitar a chamada, verifique os logs do Render e as permissões/escopos da chave.
A listagem de membros pode precisar percorrer páginas; o protótipo percorre até 20 páginas (2.000 membros). Para grupos maiores, implemente busca paginada filtrada ou ajuste o limite com cuidado.
O painel não verifica por conta própria a presença do jogador no treinamento. O instrutor autorizado deve confirmar a aprovação antes de registrar.
