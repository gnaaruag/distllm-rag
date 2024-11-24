import os
from rag_handler import RAGHandler
from exo.inference.mlx.models.llama import Model, ModelArgs
from mlx_lm.models.llama import ModelArgs as BaseModelArgs
from exo.inference.shard import Shard

def main():
    # Initialize RAG handler
    rag = RAGHandler(persist_directory="./chroma_db")
    
    # Add documents to the vector store
    # Assuming you have some text documents in a 'documents' directory
    if os.path.exists("documents"):
        rag.add_documents("documents")
    
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
