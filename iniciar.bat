@echo off
chcp 65001 > nul
title OfertaBot Local

echo.
echo  ╔══════════════════════════════════════╗
echo  ║        🥦 OfertaBot Local            ║
echo  ╚══════════════════════════════════════╝
echo.

:: Verifica se Node.js está instalado
node --version > nul 2>&1
if %errorlevel% neq 0 (
    echo  ❌ Node.js não encontrado!
    echo.
    echo  Por favor instale o Node.js:
    echo  1. Acesse: https://nodejs.org
    echo  2. Clique em "Download LTS"
    echo  3. Instale e rode este arquivo novamente
    echo.
    pause
    exit /b
)

echo  ✅ Node.js encontrado!
echo.

:: Instala dependências se necessário
if not exist "node_modules" (
    echo  📦 Instalando dependências ^(primeira vez, aguarde...^)
    echo.
    npm install
    echo.
)

:: Inicia o servidor
echo  🚀 Iniciando OfertaBot...
echo.
node server.js

pause
