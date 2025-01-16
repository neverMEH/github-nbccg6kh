import { apifyService } from '@/lib/apify';
import { apifyReviewService } from '@/lib/apify-reviews';
import { supabase } from '@/lib/supabase';
import { reviewScraperService } from './review-scraper';

interface ScrapingTask {
  id: string;
  asins: string[];
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export class ProductScraperService {
  private tasks: Map<string, ScrapingTask> = new Map();
  private runningTasks: Set<string> = new Set();

  async startScraping(asins: string[]): Promise<string> {
    try {
      if (!asins?.length) {
        throw new Error('Please provide at least one ASIN to scrape');
      }

      // Validate ASIN format
      const invalidAsins = asins.filter(asin => !asin || !/^[A-Z0-9]{10}$/.test(asin));
      if (invalidAsins.length > 0) {
        throw new Error(
          `Invalid ASIN format: ${invalidAsins.join(', ')}. ` +
          'ASINs must be 10 characters long and contain only uppercase letters and numbers.'
        );
      }

      // Check if any of these ASINs are already being processed
      const uniqueAsins = [...new Set(asins)];
      const runningAsins = uniqueAsins.filter(asin => this.runningTasks.has(asin));
      
      if (runningAsins.length > 0) {
        throw new Error(
          `Some ASINs are already being processed: ${runningAsins.join(', ')}. ` +
          'Please wait for the current process to complete before trying again.'
        );
      }

      // Mark ASINs as being processed
      uniqueAsins.forEach(asin => this.runningTasks.add(asin));

      let taskId;
      try {
        // Start Apify task
        taskId = await apifyService.startScraping(uniqueAsins);
      } catch (error) {
        // Clean up running tasks on error
        uniqueAsins.forEach(asin => this.runningTasks.delete(asin));
        throw error;
      }

      // Store task information
      const task: ScrapingTask = {
        id: taskId,
        asins: uniqueAsins,
        status: 'pending',
        progress: 0,
        startedAt: new Date().toISOString(),
      };

      this.tasks.set(taskId, task);

      // Start monitoring task progress
      this.monitorTask(taskId);

      return taskId;
    } catch (error) {
      console.error('Failed to start scraping:', error);
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('An unexpected error occurred while starting the scraping process');
    }
  }

  async getTaskStatus(taskId: string): Promise<ScrapingTask | null> {
    return this.tasks.get(taskId) || null;
  }

  private async monitorTask(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    try {
      const status = await apifyService.getTaskStatus(taskId);

      // Update task status
      task.status =
        status.status === 'SUCCEEDED'
          ? 'completed'
          : status.status === 'FAILED'
          ? 'failed'
          : 'processing';
      task.progress = status.progress;

      if (status.error) {
        task.error = status.error;
      }

      this.tasks.set(taskId, task);

      // If task is completed, process results
      if (task.status === 'completed') {
        await this.processResults(taskId);
      }
      // If task is still running, continue monitoring
      else if (task.status === 'processing') {
        setTimeout(() => this.monitorTask(taskId), 5000);
      }
    } catch (error) {
      console.error('Error monitoring task:', error);
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : 'Unknown error';
      this.tasks.set(taskId, task);
      // Clean up running tasks on error
      task.asins.forEach(asin => this.runningTasks.delete(asin));
    }
  }

  private async processResults(taskId: string) {
    try {
      const results = await apifyService.getResults(taskId);
      if (!Array.isArray(results)) {
        throw new Error('Invalid response format: Expected an array of products');
      }

      if (results.length === 0) {
        throw new Error('No product data returned from Apify');
      }

      // Store results in Supabase
      for (const product of results) {
        try {
          if (!product.asin) {
            console.warn('Skipping product with missing ASIN');
            this.runningTasks.delete(product.asin);
            continue;
          }

          // Get existing product first
          const { data: existingProduct } = await supabase
            .from('products')
            .select('id')
            .eq('asin', product.asin)
            .single();

          let productId = existingProduct?.id;
          // Prepare review summary
          const reviewSummary = {
            rating: product.rating || 0,
            reviewCount: product.reviewsCount || 0,
            starsBreakdown: product.starsBreakdown || {
              '5star': 0,
              '4star': 0,
              '3star': 0,
              '2star': 0,
              '1star': 0
            },
            verifiedPurchases: 0,
            lastUpdated: new Date().toISOString()
          };

          const productData: any = {
            asin: product.asin,
            title: product.title,
            brand: product.brand,
            price: typeof product.price === 'object' ? product.price.value : product.price,
            currency: product.currency,
            availability: product.availability,
            dimensions: product.dimensions,
            specifications: product.specifications,
            best_sellers_rank: product.bestSellersRank,
            variations: product.variations,
            frequently_bought_together: product.frequentlyBoughtTogether,
            customer_questions: product.customerQuestions,
            images: product.images,
            categories: product.categories,
            features: product.features,
            description: product.description,
            review_summary: reviewSummary,
            status: 'active',
            updated_at: new Date().toISOString()
          };

          // Update or insert product
          if (existingProduct) {
            const { error: updateError } = await supabase
                .from('products')
                .update(productData)
                .eq('id', existingProduct.id)
                .throwOnError();

            productId = existingProduct.id;
          } else {
            const { data: newProduct, error: insertError } = await supabase
                .from('products')
                .insert(productData)
                .select('id')
                .single()
                .throwOnError();

            productId = newProduct.id;
          }

          // Start review scraping after product is updated/inserted
          if (productId) {
            try {
              // Start review scraping
              await reviewScraperService.startScraping(product.asin);
              console.log(`Started review scraping for ASIN: ${product.asin}`);
            } catch (reviewError) {
              console.error(
                `Failed to start review scraping for ASIN ${product.asin}:`,
                reviewError instanceof Error ? reviewError.message : reviewError
              );
              // Don't throw here - we want to continue processing other products
            } finally {
              // Remove from running tasks after both product and review scraping attempts
              this.runningTasks.delete(product.asin);
            }
          }
        } catch (error) {
          console.error(`Failed to process product ${product.asin}:`, error);
          throw error;
        }
      }

      // Mark task as completed
      const task = this.tasks.get(taskId);
      if (task) {
        task.completedAt = new Date().toISOString();
        task.status = 'completed';
        this.tasks.set(taskId, task);
        // Clean up any remaining running tasks
        task.asins.forEach(asin => this.runningTasks.delete(asin));
      }
    } catch (error) {
      console.error('Error processing results:', error);
      const task = this.tasks.get(taskId);
      if (task) {
        task.status = 'failed';
        task.error = error instanceof Error ? error.message : 'Unknown error';
        this.tasks.set(taskId, task);
        // Clean up running tasks on error
        task.asins.forEach(asin => this.runningTasks.delete(asin));
      }
      throw error;
    }
  }
}

export const productScraperService = new ProductScraperService();