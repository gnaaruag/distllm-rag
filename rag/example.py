import os
from rag_handler import RAGHandler
from exo.inference.mlx.models.llama import Model, ModelArgs
from mlx_lm.models.llama import ModelArgs as BaseModelArgs
from exo.inference.shard import Shard

def main():
    # Initialize RAG handler
    rag = RAGHandler(persist_directory="./chroma_db")
    
    # Add documents to the vector store
    document_path = "/rag/documents"
    if os.path.exists(document_path):
        try:
            rag.add_documents(document_path)
            print(f"Successfully added documents from {document_path}")
        except Exception as e:
            print(f"Error adding documents: {str(e)}")
    else:
        print(f"Directory not found: {document_path}")
    
    # Initialize your model (using your existing infrastructure)
    base_args = BaseModelArgs()  # Base LLaMA arguments
    
    # Create a shard for the entire model (no partitioning)
    shard = Shard(
        model_id="llama-7b",  # or your specific model ID
        start_layer=0,
        end_layer=31,  # typical number of layers for LLaMA-7B, adjust as needed
        n_layers=32
    )
    
    args = ModelArgs(
        model_type="llama",
        shard=shard,
        **vars(base_args)
    )
    model = Model(args)
    
    # Example query
    query = "What are the key features of the system?"
    
    # Get augmented prompt
    augmented_prompt = rag.generate_augmented_prompt(query)
    
    # Generate response using your model
    # Note: Adjust this according to your model's interface
    response = model(augmented_prompt)  # You may need to adjust this based on your tokenization/generation pipeline
    
    print(f"Query: {query}")
    print(f"Response: {response}")

if __name__ == "__main__":
    main()
