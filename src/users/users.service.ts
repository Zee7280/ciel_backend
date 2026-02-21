import { Injectable, NotFoundException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UserRole } from './enums/user-role.enum';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
    constructor(
        @InjectRepository(User)
        private usersRepository: Repository<User>,
    ) { }

    async create(createUserDto: CreateUserDto): Promise<User> {
        if (createUserDto.password && !createUserDto.password.startsWith('$2b$')) {
            createUserDto.password = await bcrypt.hash(createUserDto.password, 10);
        }
        const user = this.usersRepository.create(createUserDto);
        return this.usersRepository.save(user);
    }

    formatUserResponse(user: User) {
        let roleTitle: string = user.role;
        // Simple mapping based on known roles
        if (user.role === UserRole.SUPER_ADMIN) roleTitle = 'Super Admin';
        else if (user.role === UserRole.STUDENT) roleTitle = 'Student'; // Capitalized for consistency
        else if (user.role === UserRole.ORGANIZATION_ADMIN) roleTitle = 'Organization Admin';
        else if (user.role === UserRole.FACULTY) roleTitle = 'Faculty';
        else if (user.role === UserRole.UNIVERSITY) roleTitle = 'University';
        else if (user.role === UserRole.NGO) roleTitle = 'NGO';
        else if (user.role === UserRole.CORPORATE) roleTitle = 'Corporate';

        return {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role, // Raw role for logic
            roleTitle: roleTitle, // Display role
            type: user.role, // keeping for backward compatibility if frontend uses it
            avatar: user.avatar,
            phone: user.phone,
            city: user.city,
            institution: user.institution,
            department: user.department,
            university: user.university,
            major: user.major,
            bio: user.bio,
            interests: user.interests,
            sdgPreferences: user.sdgPreferences,
            notifications_count: 5, // Mock/Placeholder
            organizationId: user.organization?.id,
            orgName: user.orgName,
            orgType: user.orgType,
            contactPerson: user.contactPerson,
            cnic: user.cnic,
            countryCode: user.countryCode,
            joinedDate: user.createdAt
        };
    }

    async updateGenericProfile(userId: string, dto: any) {
        const user = await this.usersRepository.findOne({ where: { id: userId } });
        if (!user) {
            throw new NotFoundException('User not found');
        }

        // Filter and map fields
        if (dto.name) user.name = dto.name;
        if (dto.institution) user.institution = dto.institution;
        if (dto.city) user.city = dto.city;
        if (dto.phone) user.phone = dto.phone;
        if (dto.avatar) user.avatar = dto.avatar;
        if (dto.bio) user.bio = dto.bio;

        // Save
        const updatedUser = await this.usersRepository.save(user);

        return {
            success: true,
            message: 'Profile updated successfully!',
            data: this.formatUserResponse(updatedUser)
        };
    }

    async findByEmail(email: string): Promise<User | null> {
        return this.usersRepository.findOne({ where: { email }, relations: ['organization'] });
    }

    async findAll(): Promise<User[]> {
        return this.usersRepository.find();
    }

    async findOne(id: string): Promise<User | null> {
        return this.usersRepository.findOne({ where: { id }, relations: ['organization'] });
    }

    async update(id: string, updateUserDto: any): Promise<User> {
        if (updateUserDto.password && !updateUserDto.password.startsWith('$2b$')) {
            updateUserDto.password = await bcrypt.hash(updateUserDto.password, 10);
        }
        await this.usersRepository.update(id, updateUserDto);
        const user = await this.findOne(id);
        if (!user) {
            throw new NotFoundException('User not found');
        }
        return user;
    }

    async remove(id: string): Promise<void> {
        await this.usersRepository.delete(id);
    }

    async getProfile(id: string) {
        console.log('getProfile called with ID:', id);
        if (!id) {
            throw new BadRequestException('User ID is required');
        }
        const user = await this.findOne(id);
        if (!user) {
            throw new NotFoundException('User not found');
        }
        console.log('Found user role:', user.role);

        return {
            success: true,
            data: this.formatUserResponse(user)
        };
    }

    async changePassword(userId: string, changePasswordDto: any) {
        const { currentPassword, newPassword } = changePasswordDto;
        const user = await this.usersRepository.findOne({ where: { id: userId } });

        if (!user) {
            throw new NotFoundException('User not found');
        }

        // Verify current password (assuming we have one)
        // If user was created without password (e.g. social login), this might need adjustment
        if (user.password) {
            const isMatch = await bcrypt.compare(currentPassword, user.password);
            if (!isMatch) {
                throw new UnauthorizedException('Current password is incorrect');
            }
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        user.password = hashedPassword;
        await this.usersRepository.save(user);

        return { success: true, message: 'Password changed successfully' };
    }
}
