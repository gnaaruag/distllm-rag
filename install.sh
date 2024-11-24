#!/bin/bash

python3 -m venv .venv
source .venv/bin/activate
pip install -e .
pip install chromadb==0.4.18 sentence-transformers==2.2.2 langchain==0.1.0 langchain-community==0.0.10 pypdf==3.17.1 tiktoken==0.5.2