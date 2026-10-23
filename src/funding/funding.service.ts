import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FundingOpportunity } from './entities/funding-opportunity.entity';
import { FundingApplication } from './entities/funding-application.entity';
import { CreateFundingApplicationDto } from './dto/create-application.dto';

@Injectable()
export class FundingService {
  constructor(
    @InjectRepository(FundingOpportunity)
    private fundingOpportunityRepository: Repository<FundingOpportunity>,
    @InjectRepository(FundingApplication)
    private fundingApplicationRepository: Repository<FundingApplication>,
  ) {}

  async findAllOpportunities() {
    // Only show open opportunities, maybe sort by deadline?
    return this.fundingOpportunityRepository.find({
      where: { status: 'open' },
      order: { deadline: 'ASC' },
    });
  }

  async createApplication(userId: string, dto: CreateFundingApplicationDto) {
    if (!userId) {
      throw new ForbiddenException(
        'Only organization accounts can apply for funding.',
      );
    }
    const opportunity = await this.fundingOpportunityRepository.findOne({
      where: { id: dto.fundingId },
    });
    if (!opportunity) {
      throw new NotFoundException('Funding opportunity not found');
    }

    const application = this.fundingApplicationRepository.create({
      ...dto,
      organizationId: userId,
      status: 'pending',
    });

    return this.fundingApplicationRepository.save(application);
  }

  async getApplications(userId: string) {
    // No organization (student / faculty / investor token): an undefined key would be dropped from
    // `where` and return every organization's applications.
    if (!userId) return [];
    return this.fundingApplicationRepository.find({
      where: { organizationId: userId },
      relations: ['fundingOpportunity'],
      order: { createdAt: 'DESC' },
    });
  }
}
