import { config } from './config';

interface ApifyTask {
  id: string;
  status: 'READY' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  startedAt?: string;
  finishedAt?: string;
  progress?: {
    percent: number;
  };
}

interface ApifyProduct {
  title: string;
  asin: string;
  price: number;
  currency: string;
  brand: string;
  availability: string;
  dimensions?: {
    width?: string;
    height?: string;
    length?: string;
    weight?: string;
  };
  specifications?: Record<string, string>;
  bestSellersRank?: Array<{
    category: string;
    rank: number;
  }>;
  variations?: Array<{
    title: string;
    asin: string;
    price?: number;
    available?: boolean;
  }>;
  frequentlyBoughtTogether?: Array<{
    asin: string;
    title: string;
    price?: number;
  }>;
  customerQuestions?: Array<{
    question: string;
    answer: string;
    votes: number;
    date: string;
  }>;
  rating: number;
  reviewsCount: number;
  starsBreakdown?: {
    '5star': number;
    '4star': number;
    '3star': number;
    '2star': number;
    '1star': number;
  };
  thumbnailImage?: string;
  images: string[];
  categories: string[];
  features: string[];
  description: string;
  reviews?: {
    id: string;
    title: string;
    text: string;
    rating: number;
    date: string;
    verified: boolean;
    author: string;
    images?: string[];
  }[];
}

class ApifyService {
  private readonly baseUrl = 'https://api.apify.com/v2';
  private readonly token: string;
  private readonly actorId = 'ZhSGsaq9MHRnWtStl';

  constructor() {
    const token = config.services.apify.token;
    if (!token) {
      throw new Error(
        'Apify API token is not configured. Please set VITE_APIFY_API_TOKEN in your environment variables.'
      );
    }
    this.token = token;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    try {
      const url = `${this.baseUrl}${endpoint}`;
      const token = this.token.trim();

      // Validate token format
      if (!token || token === 'your-apify-token' || token === 'apify_api_token') {
        throw new Error(
          'Invalid Apify API token. Please configure a valid token in your environment variables.'
        );
      }

      const response = await fetch(url, {
        ...options,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token.startsWith('apify_api_') ? token : `apify_api_${token}`}`,
          ...options.headers,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage;
        try {
          const errorData = JSON.parse(errorText);
          errorMessage = errorData.error || errorData.message || response.statusText;
        } catch {
          errorMessage = errorText || response.statusText;
        }
        throw new Error(`Apify API request failed (${response.status}): ${errorMessage}`);
      }

      const data = await response.json();

      if (!data) {
        throw new Error('Empty response from Apify API');
      }

      return data;
    } catch (error) {
      console.error('Apify API request failed:', error);
      
      // Enhance error message for token-related issues
      if (error instanceof Error && error.message.toLowerCase().includes('unauthorized')) {
        throw new Error(
          'Invalid Apify API token. Please ensure your VITE_APIFY_API_TOKEN is correct and has the necessary permissions.'
        );
      }
      
      throw error instanceof Error 
        ? error 
        : new Error('An unexpected error occurred while making the Apify request');
    }
  }

  async startScraping(asins: string[]): Promise<string> {
    const uniqueAsins = [...new Set(asins)];

    if (uniqueAsins.length === 0) {
      throw new Error('No ASINs provided');
    }

    if (uniqueAsins.length > 100) {
      throw new Error('Maximum of 100 ASINs allowed per batch');
    }

    // Validate ASINs format
    const invalidAsins = uniqueAsins.filter(asin => !/^[A-Z0-9]{10}$/.test(asin));
    if (invalidAsins.length > 0) {
      throw new Error(
        `Invalid ASIN format for: ${invalidAsins.join(', ')}. ASINs must be 10 characters long and contain only uppercase letters and numbers.`
      );
    }

    const input = {
      asins: uniqueAsins,
      amazonDomain: "amazon.com",
      maxReviews: 100,
      maxAnswers: 20,
      scrapeReviews: true,
      scrapeDescription: true,
      scrapeFilters: true,
      scrapeSpecifications: true,
      scrapeBuyingOptions: true,
      scrapeQuestions: true,
      scrapeVariants: false,
      proxyConfiguration: {
        useApifyProxy: true,
        countryCode: "US"
      },
      proxyCountry: "AUTO_SELECT_PROXY_COUNTRY",
      useCaptchaSolver: false
    };

    try {
      const result = await this.request<{ data: { id: string } }>(
        `/acts/${this.actorId}/runs`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        }
      );

      if (!result.data?.id) {
        throw new Error('Invalid response from Apify API: Missing run ID');
      }

      return result.data.id;
    } catch (error) {
      console.error('Failed to start scraping task:', error);
      throw error instanceof Error 
        ? error 
        : new Error('Failed to start scraping task');
    }
  }

  async getTaskStatus(taskId: string): Promise<{
    status: string;
    progress: number;
    error?: string;
  }> {
    try {
      const result = await this.request<{ data: ApifyTask }>(
        `/acts/${this.actorId}/runs/${taskId}`
      );

      return {
        status: result.data.status,
        progress: result.data.progress?.percent || 0,
      };
    } catch (error) {
      console.error('Failed to get task status:', error);
      throw new Error('Failed to get task status');
    }
  }

  async getResults(taskId: string): Promise<ApifyProduct[]> {
    try {
      const result = await this.request<ApifyProduct[]>(
        `/actor-runs/${taskId}/dataset/items`
      );

      return result;
    } catch (error) {
      console.error('Failed to get scraping results:', error);
      throw new Error('Failed to get scraping results');
    }
  }
}

export const apifyService = new ApifyService();