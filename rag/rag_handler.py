import math
import os
from typing import Any, Dict, List

import chromadb
from chromadb.config import Settings
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_community.document_loaders import DirectoryLoader, PyPDFLoader
from sentence_transformers import SentenceTransformer


class RAGHandler:
    def __init__(self, persist_directory: str = "chroma_db"):
        """Initialize the RAG handler with vector store and embedding model."""
        self.persist_directory = persist_directory
        
        # Initialize ChromaDB
        self.chroma_client = chromadb.Client(Settings(
            persist_directory=persist_directory,
            is_persistent=True
        ))
        
        # Initialize the embedding model
        self.embedding_model = SentenceTransformer('sentence-transformers/all-mpnet-base-v2')
        
        # Create or get the collection
        self.collection = self.chroma_client.get_or_create_collection(
            name="document_store",
            metadata={"hnsw:space": "cosine"}
        )
        
        # Initialize text splitter
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=500,
            chunk_overlap=50
        )

    def add_single_document(self, file_path: str) -> str:
        """Add a single document and return its ID."""
        loader = PyPDFLoader(file_path)
        document = loader.load()
        
        # Split document
        texts = self.text_splitter.split_documents(document)
        
        # Generate a unique document ID
        document_id = str(math.random())
        
        # Create embeddings and add to ChromaDB
        for i, doc in enumerate(texts):
            embedding = self.embedding_model.encode(doc.page_content).tolist()
            self.collection.add(
                documents=[doc.page_content],
                embeddings=[embedding],
                ids=[f"{document_id}_{i}"],
                metadatas=[{
                    "source": doc.metadata.get("source", ""),
                    "document_id": document_id
                }]
            )
        
        return document_id

    def add_documents(self, documents_dir: str) -> None:
        """Add documents from a directory to the vector store."""
        # Load documents
        loader = DirectoryLoader(documents_dir, glob="**/*.pdf", loader_cls=PyPDFLoader)
        documents = loader.load()
        
        # Split documents
        texts = self.text_splitter.split_documents(documents)
        
        # Create embeddings and add to ChromaDB
        for i, doc in enumerate(texts):
            embedding = self.embedding_model.encode(doc.page_content).tolist()
            self.collection.add(
                documents=[doc.page_content],
                embeddings=[embedding],
                ids=[f"doc_{i}"],
                metadatas=[{"source": doc.metadata.get("source", "")}]
            )

    def retrieve(self, query: str, n_results: int = 3) -> List[Dict[str, Any]]:
        """Retrieve relevant documents for a query."""
        query_embedding = self.embedding_model.encode(query).tolist()
        
        results = self.collection.query(
            query_embeddings=[query_embedding],
            n_results=n_results
        )
        
        return [{
            "content": doc,
            "metadata": meta
        } for doc, meta in zip(results["documents"][0], results["metadatas"][0])]

    def generate_augmented_prompt(self, query: str, n_results: int = 3) -> str:
        """Generate an augmented prompt with retrieved context."""
        relevant_docs = self.retrieve(query, n_results)
        
        context = "\n\n".join([doc["content"] for doc in relevant_docs])
        
        prompt = f"""Use the following context to answer the question. If you cannot answer the question based on the context, say so.

Context:
{context}

Question: {query}

Answer:"""
        
        return prompt
